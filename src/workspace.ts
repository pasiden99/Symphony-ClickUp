import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Logger } from "pino";

import { SymphonyError } from "./errors.js";
import { resolveLoginShell } from "./shell.js";
import type { EffectiveConfig, WorkspaceInfo } from "./types.js";
import { sanitizeWorkspaceKey } from "./utils.js";

type HookName = "afterCreate" | "beforeRun" | "afterRun" | "beforeRemove";

export class WorkspaceManager {
  private readonly logger: Logger;

  constructor(private config: EffectiveConfig, logger: Logger) {
    this.logger = logger.child({ component: "workspace_manager" });
  }

  updateConfig(config: EffectiveConfig): void {
    this.config = config;
  }

  async ensureForIssue(issueIdentifier: string): Promise<WorkspaceInfo> {
    await mkdir(this.config.workspace.root, { recursive: true });

    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.join(this.config.workspace.root, workspaceKey);
    this.assertInsideWorkspaceRoot(workspacePath);

    let createdNow = false;

    try {
      const stats = await stat(workspacePath);
      if (!stats.isDirectory()) {
        throw new SymphonyError(
          "invalid_workspace_path",
          `Workspace path exists but is not a directory: ${workspacePath}`
        );
      }
    } catch (error) {
      if (error instanceof SymphonyError) {
        throw error;
      }

      createdNow = true;
      await mkdir(workspacePath, { recursive: true });
    }

    if (createdNow && this.config.hooks.afterCreate) {
      try {
        await this.runHook("afterCreate", workspacePath);
      } catch (error) {
        await rm(workspacePath, { recursive: true, force: true });
        throw error;
      }
    }

    return {
      path: workspacePath,
      workspaceKey,
      createdNow
    };
  }

  async cleanupTransientArtifacts(workspacePath: string): Promise<void> {
    this.assertInsideWorkspaceRoot(workspacePath);

    const transientEntries = ["tmp", ".elixir_ls"];
    await Promise.all(
      transientEntries.map(async (entry) => {
        const targetPath = path.join(workspacePath, entry);
        await rm(targetPath, { recursive: true, force: true });
      })
    );
  }

  async removeWorkspaceForIssue(issueIdentifier: string): Promise<void> {
    const workspacePath = path.join(this.config.workspace.root, sanitizeWorkspaceKey(issueIdentifier));
    await this.removeWorkspacePath(workspacePath);
  }

  async removeWorkspacePath(workspacePath: string): Promise<void> {
    this.assertInsideWorkspaceRoot(workspacePath);

    const exists = await pathExists(workspacePath);
    if (!exists) {
      return;
    }

    if (this.config.hooks.beforeRemove) {
      await this.runHookBestEffort("beforeRemove", workspacePath);
    }

    await rm(workspacePath, { recursive: true, force: true });
  }

  async runHook(name: HookName, workspacePath: string): Promise<void> {
    this.assertInsideWorkspaceRoot(workspacePath);

    const script = this.config.hooks[name];
    if (!script) {
      return;
    }

    this.logger.info({ hook: name, workspace_path: workspacePath }, "workspace_hook_started");
    await executeShellScript({
      script,
      cwd: workspacePath,
      timeoutMs: this.config.hooks.timeoutMs
    });
  }

  async runHookBestEffort(name: HookName, workspacePath: string): Promise<void> {
    try {
      await this.runHook(name, workspacePath);
    } catch (error) {
      this.logger.warn(
        {
          hook: name,
          workspace_path: workspacePath,
          err: error instanceof Error ? error.message : String(error)
        },
        "workspace_hook_failed"
      );
    }
  }

  assertInsideWorkspaceRoot(workspacePath: string): void {
    const workspaceRoot = resolvePathPrefix(this.config.workspace.root);
    const candidate = resolvePathPrefix(workspacePath);
    if (!candidate.startsWith(workspaceRoot)) {
      throw new SymphonyError(
        "invalid_workspace_cwd",
        `Workspace path ${workspacePath} is outside workspace root ${this.config.workspace.root}`
      );
    }
  }
}

interface ExecuteShellScriptOptions {
  script: string;
  cwd: string;
  timeoutMs: number;
}

async function executeShellScript(options: ExecuteShellScriptOptions): Promise<void> {
  const { script, cwd, timeoutMs } = options;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveLoginShell(), ["-c", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SymphonyError("hook_timeout", `Workspace hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = truncateOutput(stdout + String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateOutput(stderr + String(chunk));
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SymphonyError("hook_failed", `Workspace hook failed to launch: ${error.message}`, { stdout, stderr }, error));
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new SymphonyError("hook_failed", `Workspace hook exited with code ${code ?? "null"} signal ${signal ?? "null"}`, {
          stdout,
          stderr
        })
      );
    });
  });
}

function truncateOutput(value: string): string {
  const maxLength = 4_000;
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function resolvePathPrefix(value: string): string {
  const resolved = path.resolve(value);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
