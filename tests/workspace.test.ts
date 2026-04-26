import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createLogger } from "../src/logging.js";
import type { EffectiveConfig } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

describe("WorkspaceManager", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("creates a workspace when the issue path is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-"));
    tempDirs.push(root);

    const manager = new WorkspaceManager(baseConfig(root), createLogger({ enabled: false }));
    const workspace = await manager.ensureForIssue("ENG-1");

    expect(workspace.createdNow).toBe(true);
    expect(workspace.path).toBe(path.join(root, "ENG-1"));
    expect((await fs.stat(workspace.path)).isDirectory()).toBe(true);
  });

  test("rethrows non-ENOENT stat errors instead of attempting workspace creation", async () => {
    const root = path.join(os.tmpdir(), "symphony-workspace-spy");
    const workspacePath = path.join(root, "ENG-2");
    const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const mkdirSpy = vi.fn(async (..._args: Parameters<typeof fs.mkdir>) => undefined);
    const manager = new WorkspaceManager(baseConfig(root), createLogger({ enabled: false }), {
      mkdir: mkdirSpy as typeof fs.mkdir,
      rm: vi.fn(async () => undefined) as typeof fs.rm,
      stat: vi.fn(async () => {
        throw accessError;
      }) as typeof fs.stat
    });

    await expect(manager.ensureForIssue("ENG-2")).rejects.toBe(accessError);
    expect(mkdirSpy).toHaveBeenCalledWith(root, { recursive: true });
    expect(mkdirSpy.mock.calls.some((call) => call[0] === workspacePath)).toBe(false);
  });
});

function baseConfig(root: string): EffectiveConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    tracker: {
      kind: "clickup",
      endpoint: "https://api.clickup.com/api/v2",
      apiKey: "token",
      workspaceId: "team-1",
      spaceIds: [],
      folderIds: [],
      listIds: ["list-1"],
      activeStates: ["Todo", "In Progress"],
      activeStateSet: new Set(["todo", "in progress"]),
      terminalStates: ["Done"],
      terminalStateSet: new Set(["done"])
    },
    polling: {
      intervalMs: 1000
    },
    workspace: {
      root
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1000
    },
    agent: {
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {},
      maxRetryBackoffMs: 30_000,
      maxTurns: 2
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspace-write" },
      turnTimeoutMs: 10_000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 10_000
    },
    screenshots: {
      enabled: false,
      outputDir: path.join(root, ".symphony-artifacts/screenshots"),
      maxFilesPerAttempt: 8,
      maxFileBytes: 10 * 1024 * 1024
    },
    server: {
      port: null
    }
  };
}
