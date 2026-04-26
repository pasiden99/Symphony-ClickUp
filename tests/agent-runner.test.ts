import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { AgentRunner } from "../src/agent-runner.js";
import { createLogger } from "../src/logging.js";
import type { EffectiveConfig, Issue, TrackerClient } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

describe("AgentRunner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("uses refreshed tracker config for runs after updateConfig", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-runner-"));
    tempDirs.push(root);

    const trackerCalls: string[] = [];
    const logger = createLogger({ enabled: false });
    const initialConfig = baseConfig(root, "team-1");
    const runner = new AgentRunner(
      initialConfig,
      (config): TrackerClient => ({
        fetchCandidateIssues: async () => [],
        fetchIssuesByStates: async () => [],
        fetchIssueStatesByIds: async () => {
          trackerCalls.push(config.tracker.workspaceId);
          return [baseIssue()];
        }
      }),
      new WorkspaceManager(initialConfig, logger),
      logger
    );

    const firstResult = await runner.runAttempt({
      issue: baseIssue(),
      attempt: null,
      workflowPromptTemplate: "Handle {{ issue.identifier }}",
      onEvent: () => undefined
    });

    expect(firstResult.status).toBe("succeeded");
    expect(trackerCalls).toEqual(["team-1"]);

    runner.updateConfig(baseConfig(root, "team-2"));
    const secondResult = await runner.runAttempt({
      issue: baseIssue(),
      attempt: null,
      workflowPromptTemplate: "Handle {{ issue.identifier }}",
      onEvent: () => undefined
    });

    expect(secondResult.status).toBe("succeeded");
    expect(trackerCalls).toEqual(["team-1", "team-2"]);
  });
});

function baseIssue(): Issue {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "Implement reload fix",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2025-01-01T00:00:00Z").toISOString()
  };
}

function baseConfig(root: string, workspaceId: string): EffectiveConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    tracker: {
      kind: "clickup",
      endpoint: "https://api.clickup.com/api/v2",
      apiKey: "token",
      workspaceId,
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
      maxTurns: 1
    },
    codex: {
      command: `${process.execPath} ${fixturePath}`,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspace-write" },
      turnTimeoutMs: 10_000,
      readTimeoutMs: 2_000,
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
