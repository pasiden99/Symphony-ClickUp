import { spawn } from "node:child_process";

import type { Logger } from "pino";

import { isActiveState } from "./config.js";
import { CodexAppServerClient, type CodexTurnResult } from "./codex/client.js";
import { ClickUpDynamicToolHandler } from "./codex/dynamic-tools.js";
import { SymphonyError } from "./errors.js";
import { buildContinuationPrompt, prependEnvironmentContext, renderIssuePrompt } from "./prompt.js";
import type { EffectiveConfig, Issue, LiveSessionEvent, RunAttemptResult, TrackerClient } from "./types.js";
import { formatError, nowIso } from "./utils.js";
import { WorkspaceManager } from "./workspace.js";

export interface RunAttemptOptions {
  issue: Issue;
  attempt: number | null;
  workflowPromptTemplate: string;
  onEvent: (event: LiveSessionEvent) => void;
  signal?: AbortSignal;
}

interface CliCapabilityProbe {
  available: boolean;
  ok: boolean;
  summary: string;
  details: string | null;
}

interface EnvironmentPreflight {
  notices: string[];
  githubCli: CliCapabilityProbe;
}

export class AgentRunner {
  private readonly logger: Logger;

  constructor(
    private config: EffectiveConfig,
    private readonly tracker: TrackerClient,
    private readonly workspaceManager: WorkspaceManager,
    logger: Logger
  ) {
    this.logger = logger.child({ component: "agent_runner" });
  }

  updateConfig(config: EffectiveConfig): void {
    this.config = config;
    this.workspaceManager.updateConfig(config);
  }

  async runAttempt(options: RunAttemptOptions): Promise<RunAttemptResult> {
    const { issue, attempt, workflowPromptTemplate, onEvent, signal } = options;
    let workspacePath = "";
    let session: Awaited<ReturnType<CodexAppServerClient["startSession"]>> | null = null;
    let finalIssue = issue;
    let turnCount = 0;

    const onAbort = async (): Promise<never> => {
      if (session) {
        await session.close();
      }

      throw new SymphonyError("canceled_by_reconciliation", `Run canceled for ${issue.identifier}`);
    };

    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              void onAbort().then(
                () => undefined,
                (error) => reject(error)
              );
            },
            { once: true }
          );
        })
      : null;

    try {
      const workspace = await this.workspaceManager.ensureForIssue(issue.identifier);
      workspacePath = workspace.path;

      await this.workspaceManager.cleanupTransientArtifacts(workspace.path);
      await this.workspaceManager.runHook("beforeRun", workspace.path);

      this.workspaceManager.assertInsideWorkspaceRoot(workspace.path);
      const environmentPreflight = await collectEnvironmentPreflight(workspace.path);
      onEvent({
        event: "environment_preflight",
        timestamp: nowIso(),
        message: environmentPreflight.githubCli.summary,
        raw: environmentPreflight
      });

      const codexClient = new CodexAppServerClient(
        this.config.codex,
        this.logger,
        new ClickUpDynamicToolHandler(this.config.tracker, this.logger, fetch, 30_000, {
          currentIssue: {
            id: issue.id,
            identifier: issue.identifier
          }
        })
      );
      session = await raceAbort(
        codexClient.startSession({
          workspacePath: workspace.path,
          onEvent
        }),
        abortPromise
      );

      while (turnCount < this.config.agent.maxTurns) {
        turnCount += 1;
        const basePrompt =
          turnCount === 1
            ? await renderIssuePrompt(workflowPromptTemplate, finalIssue, attempt)
            : buildContinuationPrompt(finalIssue, turnCount, this.config.agent.maxTurns);
        const prompt =
          turnCount === 1 ? prependEnvironmentContext(basePrompt, environmentPreflight.notices) : basePrompt;

        const turnResult = await raceAbort(
          session.runTurn({
            prompt,
            title: `${finalIssue.identifier}: ${finalIssue.title}`
          }),
          abortPromise
        );

        if (turnResult.status !== "completed") {
          return {
            status: mapTurnStatus(turnResult),
            issue: finalIssue,
            attempt,
            workspacePath,
            error: turnResult.error,
            turnCount
          };
        }

        const refreshed = await raceAbort(this.tracker.fetchIssueStatesByIds([finalIssue.id]), abortPromise);
        const refreshedIssue = refreshed[0];
        if (!refreshedIssue) {
          throw new SymphonyError("clickup_unknown_payload", `Tracker did not return task ${finalIssue.id} after turn completion`);
        }

        finalIssue = refreshedIssue;
        if (!isActiveState(this.config, finalIssue.state)) {
          break;
        }
      }

      return {
        status: "succeeded",
        issue: finalIssue,
        attempt,
        workspacePath,
        error: null,
        turnCount
      };
    } catch (error) {
      if (error instanceof SymphonyError && error.code === "canceled_by_reconciliation") {
        return {
          status: "canceled_by_reconciliation",
          issue: finalIssue,
          attempt,
          workspacePath,
          error: error.message,
          turnCount
        };
      }

      if (error instanceof SymphonyError && error.code === "turn_input_required") {
        return {
          status: "blocked",
          issue: finalIssue,
          attempt,
          workspacePath,
          error: error.message,
          turnCount
        };
      }

      const code = error instanceof SymphonyError ? error.code : null;
      if (code === "turn_timeout") {
        return {
          status: "timed_out",
          issue: finalIssue,
          attempt,
          workspacePath,
          error: error instanceof Error ? error.message : String(error),
          turnCount
        };
      }

      return {
        status: "failed",
        issue: finalIssue,
        attempt,
        workspacePath,
        error: formatError(error),
        turnCount
      };
    } finally {
      if (session) {
        await session.close().catch(() => undefined);
      }

      if (workspacePath) {
        await this.workspaceManager.runHookBestEffort("afterRun", workspacePath);
      }
    }
  }
}

async function raceAbort<T>(promise: Promise<T>, abortPromise: Promise<never> | null): Promise<T> {
  if (!abortPromise) {
    return promise;
  }

  return Promise.race([promise, abortPromise]);
}

function mapTurnStatus(result: CodexTurnResult): RunAttemptResult["status"] {
  if (isInteractiveInputFailure(result.error)) {
    return "blocked";
  }

  if (result.status === "cancelled") {
    return "failed";
  }

  return "failed";
}

function isInteractiveInputFailure(message: string | null): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("interactive input required") ||
    normalized.includes("requested interactive user input") ||
    normalized.includes("requestuserinput")
  );
}

async function collectEnvironmentPreflight(workspacePath: string): Promise<EnvironmentPreflight> {
  const githubCli = await probeGithubCliAuth(workspacePath);
  const notices: string[] = [];

  if (!githubCli.available) {
    notices.push("GitHub CLI (`gh`) is not installed in this environment.");
  } else if (!githubCli.ok) {
    notices.push(
      `GitHub CLI authentication is unavailable for PR work in this environment: ${githubCli.summary}`
    );
    notices.push("Do not burn turns repeatedly retrying `gh` commands in this session.");
    notices.push("If implementation completes, record the blocker in ClickUp and stop at the blocker.");
  }

  return {
    notices,
    githubCli
  };
}

async function probeGithubCliAuth(workspacePath: string): Promise<CliCapabilityProbe> {
  try {
    const { code, stdout, stderr } = await runProcess("gh", ["auth", "status"], workspacePath);
    const details = [stdout, stderr].filter((chunk) => chunk.trim() !== "").join("\n").trim() || null;

    if (code === 0) {
      return {
        available: true,
        ok: true,
        summary: "GitHub CLI authentication is available.",
        details
      };
    }

    return {
      available: true,
      ok: false,
      summary: summarizeCliFailure(details) ?? "GitHub CLI authentication is unavailable.",
      details
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return {
        available: false,
        ok: false,
        summary: "GitHub CLI (`gh`) is not installed.",
        details: null
      };
    }

    return {
      available: true,
      ok: false,
      summary: `GitHub CLI probe failed: ${message}`,
      details: null
    };
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function summarizeCliFailure(details: string | null): string | null {
  if (!details) {
    return null;
  }

  const trimmed = details.trim();
  const preferredLine =
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line !== "" &&
          !line.startsWith("github.com") &&
          !line.startsWith("X Failed to log in") &&
          !line.startsWith("- Active account:") &&
          !line.startsWith("- To re-authenticate") &&
          !line.startsWith("- To forget about")
      ) ?? trimmed.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");

  return preferredLine ?? null;
}
