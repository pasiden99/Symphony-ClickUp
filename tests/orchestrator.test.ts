import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Orchestrator } from "../src/orchestrator.js";
import type { EffectiveConfig, Issue, RunAttemptResult, TrackerClient, WorkflowDefinition } from "../src/types.js";
import { createLogger } from "../src/logging.js";

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("dispatches eligible work and schedules continuation retry on success", async () => {
    const candidate: Issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Do the work",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
      updatedAt: null
    };

    const tracker: TrackerClient = {
      fetchCandidateIssues: vi.fn(async () => [candidate]),
      fetchIssuesByStates: vi.fn(async () => []),
      fetchIssueStatesByIds: vi.fn(async () => [candidate])
    };

    const workspaceManager = {
      updateConfig: vi.fn(),
      removeWorkspaceForIssue: vi.fn(async () => undefined)
    };

    const agentRunner = {
      updateConfig: vi.fn(),
      runAttempt: vi.fn(async () => {
        return {
          status: "succeeded",
          issue: candidate,
          attempt: null,
          workspacePath: "/tmp/ws/ENG-1",
          error: null,
          turnCount: 1
        } satisfies RunAttemptResult;
      })
    };

    const orchestrator = new Orchestrator(
      baseConfig(),
      baseWorkflow(),
      () => tracker,
      workspaceManager as never,
      agentRunner as never,
      createLogger({ enabled: false })
    );

    await orchestrator.start();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    const snapshot = orchestrator.getRuntimeSnapshot();
    expect(snapshot.counts.running).toBe(0);
    expect(snapshot.counts.retrying).toBe(1);
    expect(snapshot.retrying[0]?.issueIdentifier).toBe("ENG-1");
  });

  test("does not dispatch todo issues with non-terminal blockers", async () => {
    const blocked: Issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Blocked task",
      description: null,
      priority: 1,
      state: "Todo",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [{ id: "2", identifier: "ENG-0", state: "In Progress" }],
      createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
      updatedAt: null
    };

    const tracker: TrackerClient = {
      fetchCandidateIssues: vi.fn(async () => [blocked]),
      fetchIssuesByStates: vi.fn(async () => []),
      fetchIssueStatesByIds: vi.fn(async () => [blocked])
    };

    const agentRunner = {
      updateConfig: vi.fn(),
      runAttempt: vi.fn()
    };

    const orchestrator = new Orchestrator(
      baseConfig(),
      baseWorkflow(),
      () => tracker,
      {
        updateConfig: vi.fn(),
        removeWorkspaceForIssue: vi.fn(async () => undefined)
      } as never,
      agentRunner as never,
      createLogger({ enabled: false })
    );

    await orchestrator.start();
    await vi.runOnlyPendingTimersAsync();
    expect(agentRunner.runAttempt).not.toHaveBeenCalled();
  });
});

function baseWorkflow(): WorkflowDefinition {
  return {
    filePath: "/tmp/WORKFLOW.md",
    loadedAt: new Date().toISOString(),
    promptTemplate: "Hello {{ issue.identifier }}",
    config: {}
  };
}

function baseConfig(): EffectiveConfig {
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
      root: "/tmp/workspaces"
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
    server: {
      port: null
    }
  };
}
