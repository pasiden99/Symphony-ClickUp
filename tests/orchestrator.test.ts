import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AuditRecorder } from "../src/audit.js";
import { SymphonyError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { AuditEventInput, EffectiveConfig, Issue, RunAttemptResult, TrackerClient, WorkflowDefinition } from "../src/types.js";
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

  test("records inactive reconciliation cancellation as a non-failed dispatch finish", async () => {
    let candidate: Issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Move to review",
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
    const audit = createFakeAuditRecorder();
    const agentRunner = {
      updateConfig: vi.fn(),
      runAttempt: vi.fn(
        (options: { signal?: AbortSignal }) =>
          new Promise<RunAttemptResult>((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                resolve({
                  status: "failed",
                  issue: candidate,
                  attempt: null,
                  workspacePath: "/tmp/ws/ENG-1",
                  error: "Codex aborted",
                  turnCount: 1
                });
              },
              { once: true }
            );
          })
      )
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
      createLogger({ enabled: false }),
      audit
    );

    await orchestrator.start();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    candidate = {
      ...candidate,
      state: "Human Review",
      updatedAt: new Date("2025-01-01T00:01:00Z").toISOString()
    };

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    const dispatchFinished = [...audit.events].reverse().find((event) => event.action === "dispatch_finished");
    expect(dispatchFinished).toMatchObject({
      level: "info",
      message: "inactive state Human Review",
      data: {
        status: "failed",
        cancellationKind: "inactive"
      }
    });

    await orchestrator.stop();
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

  test("emits audit events for dispatch, session activity, completion, and retry scheduling", async () => {
    const candidate: Issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Audited work",
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
    const audit = createFakeAuditRecorder();
    const agentRunner = {
      updateConfig: vi.fn(),
      runAttempt: vi.fn(async (options: { onEvent: (event: { event: string; timestamp: string; sessionId?: string; raw?: unknown }) => void }) => {
        options.onEvent({
          event: "session_started",
          timestamp: new Date("2025-01-01T00:00:01Z").toISOString(),
          sessionId: "session-1",
          raw: {
            workspacePath: "/tmp/ws/ENG-1"
          }
        });
        return {
          status: "failed",
          issue: candidate,
          attempt: null,
          workspacePath: "/tmp/ws/ENG-1",
          error: "boom",
          turnCount: 1
        } satisfies RunAttemptResult;
      })
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
      createLogger({ enabled: false }),
      audit
    );

    await orchestrator.start();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(audit.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["service_started", "dispatch_started", "session_started", "dispatch_finished", "retry_scheduled"])
    );
    expect(audit.events.find((event) => event.action === "session_started")).toMatchObject({
      category: "codex",
      issueIdentifier: "ENG-1",
      workspacePath: "/tmp/ws/ENG-1"
    });
  });

  test("emits audit events for blocked work and invalid workflow config", async () => {
    const audit = createFakeAuditRecorder();
    const candidate: Issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Blocked work",
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
    const orchestrator = new Orchestrator(
      baseConfig(),
      baseWorkflow(),
      () => ({
        fetchCandidateIssues: vi.fn(async () => [candidate]),
        fetchIssuesByStates: vi.fn(async () => []),
        fetchIssueStatesByIds: vi.fn(async () => [candidate])
      }),
      {
        updateConfig: vi.fn(),
        removeWorkspaceForIssue: vi.fn(async () => undefined)
      } as never,
      {
        updateConfig: vi.fn(),
        runAttempt: vi.fn(async () => ({
          status: "blocked",
          issue: candidate,
          attempt: null,
          workspacePath: "/tmp/ws/ENG-1",
          error: "Interactive input required",
          turnCount: 1
        } satisfies RunAttemptResult))
      } as never,
      createLogger({ enabled: false }),
      audit
    );

    await orchestrator.start();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    orchestrator.applyInvalidWorkflow(new SymphonyError("workflow_reload_failed", "bad workflow"));

    expect(audit.events).toContainEqual(
      expect.objectContaining({
        action: "dispatch_blocked_pending_external_change",
        level: "warn",
        issueIdentifier: "ENG-1"
      })
    );
    expect(audit.events).toContainEqual(
      expect.objectContaining({
        action: "workflow_reload_failed",
        level: "error",
        category: "config"
      })
    );
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
    screenshots: {
      enabled: false,
      outputDir: "/tmp/workspaces/.symphony-artifacts/screenshots",
      maxFilesPerAttempt: 8,
      maxFileBytes: 10 * 1024 * 1024
    },
    audit: {
      enabled: true,
      outputDir: "/tmp/workspaces/.symphony-artifacts/audit",
      maxRecentEvents: 500,
      maxEventBytes: 16_384,
      retentionDays: 14,
      includeRawCodexEvents: false
    },
    server: {
      port: null
    }
  };
}

function createFakeAuditRecorder(): AuditRecorder & { events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return {
    events,
    async initialize() {
      return undefined;
    },
    updateConfig: vi.fn(),
    async record(event: AuditEventInput) {
      events.push(event);
      return null;
    },
    query() {
      return {
        generatedAt: new Date().toISOString(),
        events: [],
        total: 0,
        limit: 200
      };
    },
    getSummary() {
      return {
        enabled: true,
        recentCount: events.length,
        errorCount: events.filter((event) => event.level === "error").length,
        warnCount: events.filter((event) => event.level === "warn").length,
        failedRecentCount: 0,
        lastEventAt: null
      };
    },
    subscribe() {
      return () => undefined;
    },
    async flush() {
      return undefined;
    }
  };
}
