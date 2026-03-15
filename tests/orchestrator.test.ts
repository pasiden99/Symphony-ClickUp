import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SymphonyError } from "../src/errors.js";
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

  test("retries failed work with a numbered attempt instead of redispatching as a fresh run", async () => {
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

    const agentRunner = {
      updateConfig: vi.fn(),
      runAttempt: vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          issue: candidate,
          attempt: null,
          workspacePath: "/tmp/ws/ENG-1",
          error: "port_exit",
          turnCount: 0
        } satisfies RunAttemptResult)
        .mockResolvedValueOnce({
          status: "succeeded",
          issue: candidate,
          attempt: 1,
          workspacePath: "/tmp/ws/ENG-1",
          error: null,
          turnCount: 1
        } satisfies RunAttemptResult)
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
    await Promise.resolve();
    expect(agentRunner.runAttempt).toHaveBeenCalledTimes(1);
    expect(agentRunner.runAttempt.mock.calls[0]?.[0].attempt).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(agentRunner.runAttempt).toHaveBeenCalledTimes(2);
    expect(agentRunner.runAttempt.mock.calls[1]?.[0].attempt).toBe(1);
  });

  test("holds blocked work until the task changes instead of retrying the same attempt", async () => {
    let candidate: Issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Needs a human answer",
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

    const tracker: TrackerClient = {
      fetchCandidateIssues: vi.fn(async () => [candidate]),
      fetchIssuesByStates: vi.fn(async () => []),
      fetchIssueStatesByIds: vi.fn(async () => [candidate])
    };

    const agentRunner = {
      updateConfig: vi.fn(),
      runAttempt: vi
        .fn()
        .mockResolvedValueOnce({
          status: "blocked",
          issue: candidate,
          attempt: null,
          workspacePath: "/tmp/ws/ENG-1",
          error: "Interactive input required",
          turnCount: 1
        } satisfies RunAttemptResult)
        .mockResolvedValueOnce({
          status: "succeeded",
          issue: candidate,
          attempt: null,
          workspacePath: "/tmp/ws/ENG-1",
          error: null,
          turnCount: 1
        } satisfies RunAttemptResult)
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
    await Promise.resolve();

    expect(agentRunner.runAttempt).toHaveBeenCalledTimes(1);
    expect(orchestrator.getRuntimeSnapshot().counts.retrying).toBe(0);
    expect(orchestrator.getIssueSnapshot("ENG-1")?.status).toBe("blocked");

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(agentRunner.runAttempt).toHaveBeenCalledTimes(1);

    candidate = {
      ...candidate,
      updatedAt: new Date("2025-01-01T00:01:00Z").toISOString()
    };

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(agentRunner.runAttempt).toHaveBeenCalledTimes(2);
  });

  test("coalesces runtime snapshot notifications for bursty state changes", async () => {
    const orchestrator = new Orchestrator(
      baseConfig(),
      baseWorkflow(),
      () => ({
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssuesByStates: vi.fn(async () => []),
        fetchIssueStatesByIds: vi.fn(async () => [])
      }),
      {
        updateConfig: vi.fn(),
        removeWorkspaceForIssue: vi.fn(async () => undefined)
      } as never,
      {
        updateConfig: vi.fn(),
        runAttempt: vi.fn()
      } as never,
      createLogger({ enabled: false })
    );

    const listener = vi.fn();
    const unsubscribe = orchestrator.subscribeRuntimeSnapshots(listener);

    orchestrator.applyInvalidWorkflow(new SymphonyError("workflow_reload_failed", "first failure"));
    orchestrator.applyInvalidWorkflow(new SymphonyError("workflow_reload_failed", "second failure"));

    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].lastConfigError).toEqual({
      code: "workflow_reload_failed",
      message: "second failure"
    });

    unsubscribe();
    orchestrator.applyInvalidWorkflow(new SymphonyError("workflow_reload_failed", "third failure"));
    await vi.advanceTimersByTimeAsync(100);

    expect(listener).toHaveBeenCalledTimes(1);
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
