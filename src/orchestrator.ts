import type { Logger } from "pino";

import { AgentRunner } from "./agent-runner.js";
import { isActiveState, isTerminalState, perStateConcurrencyLimit, validateDispatchConfig } from "./config.js";
import { SymphonyError } from "./errors.js";
import type {
  EffectiveConfig,
  Issue,
  IssueRuntimeSnapshot,
  LiveSessionEvent,
  LiveSessionSnapshot,
  RetryEntry,
  RetrySnapshotRow,
  RunAttemptResult,
  RuntimeSnapshot,
  RuntimeTotals,
  TrackerClient,
  WorkflowDefinition
} from "./types.js";
import { delayForAttempt, formatError, normalizeStateName, nowIso } from "./utils.js";
import { WorkspaceManager } from "./workspace.js";

type TrackerFactory = (config: EffectiveConfig) => TrackerClient;

interface RunningEntry {
  issue: Issue;
  identifier: string;
  retryAttempt: number | null;
  startedAt: string;
  startedAtMs: number;
  workspacePath: string | null;
  session: LiveSessionSnapshot;
  abortController: AbortController;
  lastError: string | null;
  promise: Promise<void>;
  cancellation: {
    kind: "terminal" | "inactive" | "stalled" | "service_stop";
    cleanupWorkspace: boolean;
    reason: string;
  } | null;
}

type CancellationKind = NonNullable<RunningEntry["cancellation"]>["kind"];

interface RetryState {
  entry: RetryEntry;
  timer: NodeJS.Timeout;
}

interface IssueTrackingState {
  issueId: string;
  issueIdentifier: string;
  workspacePath: string | null;
  restartCount: number;
  currentRetryAttempt: number | null;
  lastError: string | null;
  recentEvents: Array<{
    at: string;
    event: string;
    message: string | null;
  }>;
}

export class Orchestrator {
  private readonly logger: Logger;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryState>();
  private readonly completed = new Set<string>();
  private readonly issueTracking = new Map<string, IssueTrackingState>();
  private readonly codexTotals: RuntimeTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0
  };
  private tracker: TrackerClient;
  private stopped = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private refreshRequested = false;
  private lastConfigError: { code: string; message: string } | null = null;
  private latestRateLimits: Record<string, unknown> | null = null;

  constructor(
    private config: EffectiveConfig,
    private workflow: WorkflowDefinition,
    private readonly trackerFactory: TrackerFactory,
    private readonly workspaceManager: WorkspaceManager,
    private readonly agentRunner: AgentRunner,
    logger: Logger
  ) {
    this.logger = logger.child({ component: "orchestrator" });
    this.tracker = trackerFactory(config);
  }

  async start(): Promise<void> {
    validateDispatchConfig(this.config);

    try {
      await this.startupTerminalWorkspaceCleanup();
    } catch (error) {
      this.logger.warn({ err: formatError(error) }, "startup_terminal_workspace_cleanup_failed");
    }

    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    for (const retryState of this.retryAttempts.values()) {
      clearTimeout(retryState.timer);
    }
    this.retryAttempts.clear();

    const runningEntries = [...this.running.values()];
    for (const entry of runningEntries) {
      entry.cancellation = {
        kind: "service_stop",
        cleanupWorkspace: false,
        reason: "service stopping"
      };
      entry.abortController.abort();
    }

    await Promise.allSettled(runningEntries.map((entry) => entry.promise));
  }

  updateWorkflow(workflow: WorkflowDefinition, config: EffectiveConfig): void {
    this.workflow = workflow;
    this.config = config;
    this.tracker = this.trackerFactory(config);
    this.workspaceManager.updateConfig(config);
    this.agentRunner.updateConfig(config);
    this.lastConfigError = null;

    if (!this.stopped) {
      this.scheduleTick(0);
    }
  }

  applyInvalidWorkflow(error: SymphonyError): void {
    this.lastConfigError = {
      code: error.code,
      message: error.message
    };
    this.logger.error({ code: error.code, message: error.message }, "workflow_reload_failed");
  }

  async requestRefresh(): Promise<{ queued: boolean; coalesced: boolean }> {
    if (this.tickInProgress) {
      this.refreshRequested = true;
      return { queued: true, coalesced: true };
    }

    this.scheduleTick(0);
    return { queued: true, coalesced: false };
  }

  getRuntimeSnapshot(): RuntimeSnapshot {
    const generatedAt = nowIso();
    const running = [...this.running.values()].map((entry) => this.toRunningRow(entry));
    const retrying = [...this.retryAttempts.values()]
      .map((state) => state.entry)
      .sort((left, right) => left.dueAtMs - right.dueAtMs)
      .map((entry) => ({
        issueId: entry.issueId,
        issueIdentifier: entry.identifier,
        attempt: entry.attempt,
        dueAt: new Date(entry.dueAtMs).toISOString(),
        error: entry.error
      }));

    return {
      generatedAt,
      counts: {
        running: running.length,
        retrying: retrying.length
      },
      running,
      retrying,
      codexTotals: {
        inputTokens: this.codexTotals.inputTokens,
        outputTokens: this.codexTotals.outputTokens,
        totalTokens: this.codexTotals.totalTokens,
        secondsRunning: this.computeRuntimeSeconds()
      },
      rateLimits: this.latestRateLimits,
      workflow: {
        path: this.workflow.filePath,
        promptTemplateEmpty: this.workflow.promptTemplate.trim() === ""
      },
      lastConfigError: this.lastConfigError
    };
  }

  getIssueSnapshot(issueIdentifier: string): IssueRuntimeSnapshot | null {
    const tracking = [...this.issueTracking.values()].find((entry) => entry.issueIdentifier === issueIdentifier);
    if (!tracking) {
      return null;
    }

    const runningEntry = [...this.running.values()].find((entry) => entry.identifier === issueIdentifier) ?? null;
    const retryEntry = [...this.retryAttempts.values()].find((state) => state.entry.identifier === issueIdentifier)?.entry ?? null;

    return {
      issueIdentifier: tracking.issueIdentifier,
      issueId: tracking.issueId,
      status: runningEntry
        ? "running"
        : retryEntry
          ? "retrying"
          : this.claimed.has(tracking.issueId)
            ? "claimed"
            : "released",
      workspace: {
        path:
          tracking.workspacePath ??
          `${this.config.workspace.root}/${tracking.issueIdentifier.replace(/[^A-Za-z0-9._-]/g, "_")}`
      },
      attempts: {
        restartCount: tracking.restartCount,
        currentRetryAttempt: tracking.currentRetryAttempt
      },
      running: runningEntry ? this.toRunningRow(runningEntry) : null,
      retry: retryEntry
        ? {
            issueId: retryEntry.issueId,
            issueIdentifier: retryEntry.identifier,
            attempt: retryEntry.attempt,
            dueAt: new Date(retryEntry.dueAtMs).toISOString(),
            error: retryEntry.error
          }
        : null,
      lastError: tracking.lastError,
      recentEvents: [...tracking.recentEvents],
      tracked: {}
    };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }

    this.tickTimer = setTimeout(() => {
      void this.runTickLoop();
    }, Math.max(0, delayMs));
  }

  private async runTickLoop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.tickInProgress) {
      this.refreshRequested = true;
      return;
    }

    this.tickInProgress = true;
    this.tickTimer = null;

    try {
      await this.onTick();
    } finally {
      this.tickInProgress = false;

      if (this.stopped) {
        return;
      }

      if (this.refreshRequested) {
        this.refreshRequested = false;
        this.scheduleTick(0);
      } else {
        this.scheduleTick(this.config.polling.intervalMs);
      }
    }
  }

  private async onTick(): Promise<void> {
    await this.reconcileRunningIssues();

    try {
      validateDispatchConfig(this.config);
      this.lastConfigError = null;
    } catch (error) {
      const configError = ensureSymphonyError(error, "config_validation_failed");
      this.lastConfigError = { code: configError.code, message: configError.message };
      this.logger.error({ code: configError.code, message: configError.message }, "dispatch_validation_failed");
      return;
    }

    let issues: Issue[];
    try {
      issues = await this.tracker.fetchCandidateIssues();
    } catch (error) {
      this.logger.error({ err: formatError(error) }, "candidate_fetch_failed");
      return;
    }

    for (const issue of sortIssuesForDispatch(issues)) {
      if (!this.hasAvailableGlobalSlots()) {
        break;
      }

      if (this.shouldDispatch(issue)) {
        this.dispatchIssue(issue, null);
      }
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    const stallTimeoutMs = this.config.codex.stallTimeoutMs;
    if (stallTimeoutMs > 0) {
      const now = Date.now();
      for (const [issueId, entry] of this.running.entries()) {
        const lastSeenMs = entry.session.lastCodexTimestamp ? Date.parse(entry.session.lastCodexTimestamp) : entry.startedAtMs;
        if (now - lastSeenMs > stallTimeoutMs) {
          this.logger.warn({ issue_id: issueId, issue_identifier: entry.identifier }, "stalled_run_detected");
          this.requestCancellation(entry, "stalled", false, "stall timeout exceeded");
        }
      }
    }

    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) {
      return;
    }

    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.logger.warn({ err: formatError(error) }, "running_state_refresh_failed");
      return;
    }

    const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const [issueId, entry] of this.running.entries()) {
      const current = refreshedById.get(issueId);
      if (!current) {
        continue;
      }

      entry.issue = current;
      if (isTerminalState(this.config, current.state)) {
        this.requestCancellation(entry, "terminal", true, `terminal state ${current.state}`);
      } else if (!isActiveState(this.config, current.state)) {
        this.requestCancellation(entry, "inactive", false, `inactive state ${current.state}`);
      }
    }
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    const terminalIssues = await this.tracker.fetchIssuesByStates(this.config.tracker.terminalStates);
    await Promise.allSettled(terminalIssues.map((issue) => this.workspaceManager.removeWorkspaceForIssue(issue.identifier)));
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abortController = new AbortController();
    const tracking = this.ensureIssueTracking(issue);
    tracking.currentRetryAttempt = attempt;

    const runningEntry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      retryAttempt: attempt,
      startedAt: nowIso(),
      startedAtMs: Date.now(),
      workspacePath: null,
      session: emptySessionSnapshot(),
      abortController,
      lastError: null,
      promise: Promise.resolve(),
      cancellation: null
    };

    this.running.set(issue.id, runningEntry);
    this.claimed.add(issue.id);

    const retryState = this.retryAttempts.get(issue.id);
    if (retryState) {
      clearTimeout(retryState.timer);
      this.retryAttempts.delete(issue.id);
    }

    this.logger.info({ issue_id: issue.id, issue_identifier: issue.identifier, attempt }, "dispatch_started");

    const promise = this.agentRunner
      .runAttempt({
        issue,
        attempt,
        workflowPromptTemplate: this.workflow.promptTemplate,
        onEvent: (event) => this.handleSessionEvent(issue.id, event),
        signal: abortController.signal
      })
      .then((result) => this.handleWorkerExit(issue.id, result))
      .catch((error) => {
        const fallback: RunAttemptResult = {
          status: "failed",
          issue,
          attempt,
          workspacePath: runningEntry.workspacePath ?? "",
          error: formatError(error),
          turnCount: runningEntry.session.turnCount
        };
        return this.handleWorkerExit(issue.id, fallback);
      });

    runningEntry.promise = promise;
  }

  private handleSessionEvent(issueId: string, event: LiveSessionEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    entry.session.codexAppServerPid = event.codexAppServerPid ?? entry.session.codexAppServerPid;
    entry.session.sessionId = event.sessionId ?? entry.session.sessionId;
    entry.session.threadId = event.threadId ?? entry.session.threadId;
    entry.session.turnId = event.turnId ?? entry.session.turnId;
    entry.session.lastCodexEvent = event.event;
    entry.session.lastCodexTimestamp = event.timestamp;
    entry.session.lastCodexMessage = event.message ?? null;

    if (event.event === "session_started") {
      entry.session.turnCount += 1;
      this.logger.info(
        {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          session_id: event.sessionId ?? entry.session.sessionId,
          turn_id: event.turnId ?? entry.session.turnId,
          turn_count: entry.session.turnCount
        },
        "turn_started"
      );
    }

    if (
      event.event === "environment_preflight" ||
      event.event === "dynamic_tools_advertised" ||
      event.event === "dynamic_tools_unavailable" ||
      event.event === "dynamic_tool_call_completed" ||
      event.event === "unsupported_tool_call"
    ) {
      this.logger.info(
        {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          event: event.event,
          message: event.message ?? null,
          raw: event.raw ?? null
        },
        "tool_event"
      );
    }

    if (isTerminalSessionEvent(event.event)) {
      this.logger.info(
        {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          event: event.event,
          turn_id: event.turnId ?? entry.session.turnId,
          message: event.message ?? null
        },
        "turn_event"
      );
    }

    if (event.usage) {
      const inputTokens = event.usage.inputTokens ?? entry.session.codexInputTokens;
      const outputTokens = event.usage.outputTokens ?? entry.session.codexOutputTokens;
      const totalTokens = event.usage.totalTokens ?? entry.session.codexTotalTokens;

      const inputDelta = Math.max(0, inputTokens - entry.session.lastReportedInputTokens);
      const outputDelta = Math.max(0, outputTokens - entry.session.lastReportedOutputTokens);
      const totalDelta = Math.max(0, totalTokens - entry.session.lastReportedTotalTokens);

      entry.session.codexInputTokens = inputTokens;
      entry.session.codexOutputTokens = outputTokens;
      entry.session.codexTotalTokens = totalTokens;
      entry.session.lastReportedInputTokens = inputTokens;
      entry.session.lastReportedOutputTokens = outputTokens;
      entry.session.lastReportedTotalTokens = totalTokens;

      this.codexTotals.inputTokens += inputDelta;
      this.codexTotals.outputTokens += outputDelta;
      this.codexTotals.totalTokens += totalDelta;
    }

    if (event.rateLimits) {
      this.latestRateLimits = event.rateLimits;
    }

    const tracking = this.ensureIssueTracking(entry.issue);
    tracking.recentEvents.push({
      at: event.timestamp,
      event: event.event,
      message: event.message ?? null
    });
    if (tracking.recentEvents.length > 50) {
      tracking.recentEvents.shift();
    }
  }

  private async handleWorkerExit(issueId: string, result: RunAttemptResult): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    this.running.delete(issueId);
    this.codexTotals.secondsRunning += Math.max(0, (Date.now() - entry.startedAtMs) / 1000);

    const tracking = this.ensureIssueTracking(result.issue);
    tracking.workspacePath = result.workspacePath || tracking.workspacePath;
    tracking.lastError = result.error;
    tracking.currentRetryAttempt = null;

    this.logger.info(
      {
        issue_id: issueId,
        issue_identifier: result.issue.identifier,
        attempt: result.attempt,
        status: result.status,
        turn_count: result.turnCount,
        error: result.error,
        workspace_path: result.workspacePath || null,
        last_event: entry.session.lastCodexEvent,
        last_message: entry.session.lastCodexMessage
      },
      "dispatch_finished"
    );

    if (entry.cancellation) {
      if (entry.cancellation.cleanupWorkspace && result.issue.identifier) {
        await this.workspaceManager.removeWorkspaceForIssue(result.issue.identifier).catch((error) => {
          this.logger.warn({ err: formatError(error), issue_id: issueId }, "workspace_cleanup_failed");
        });
      }

      if (entry.cancellation.kind === "stalled") {
        this.scheduleRetry(result.issue, this.nextAttempt(entry.retryAttempt), entry.cancellation.reason);
      } else {
        this.claimed.delete(issueId);
      }
      return;
    }

    if (result.status === "succeeded") {
      this.completed.add(issueId);
      this.scheduleRetry(result.issue, 1, null, true);
      return;
    }

    if (result.status === "canceled_by_reconciliation") {
      this.claimed.delete(issueId);
      return;
    }

    this.scheduleRetry(result.issue, this.nextAttempt(entry.retryAttempt), result.error);
  }

  private requestCancellation(
    entry: RunningEntry,
    kind: CancellationKind,
    cleanupWorkspace: boolean,
    reason: string
  ): void {
    if (entry.cancellation) {
      return;
    }

    entry.cancellation = {
      kind,
      cleanupWorkspace,
      reason
    };
    entry.abortController.abort();
  }

  private scheduleRetry(issue: Issue, attempt: number, error: string | null, continuation = false): void {
    const delayMs = continuation ? 1_000 : delayForAttempt(attempt, this.config.agent.maxRetryBackoffMs);
    const dueAtMs = Date.now() + delayMs;

    const existing = this.retryAttempts.get(issue.id);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAtMs,
      error
    };

    const timer = setTimeout(() => {
      void this.onRetryTimer(issue.id);
    }, delayMs);

    this.retryAttempts.set(issue.id, { entry, timer });
    this.claimed.add(issue.id);

    this.logger.info(
      {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        attempt,
        delay_ms: delayMs,
        continuation,
        error
      },
      continuation ? "continuation_scheduled" : "retry_scheduled"
    );

    const tracking = this.ensureIssueTracking(issue);
    tracking.restartCount += 1;
    tracking.currentRetryAttempt = attempt;
    tracking.lastError = error;
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryState = this.retryAttempts.get(issueId);
    if (!retryState) {
      return;
    }
    this.retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (error) {
      const tracking = [...this.issueTracking.values()].find((entry) => entry.issueId === issueId);
      if (tracking) {
        this.scheduleRetry(
          {
            id: tracking.issueId,
            identifier: tracking.issueIdentifier,
            title: tracking.issueIdentifier,
            description: null,
            priority: null,
            state: this.config.tracker.activeStates[0] ?? "Todo",
            branchName: null,
            url: null,
            labels: [],
            blockedBy: [],
            createdAt: null,
            updatedAt: null
          },
          retryState.entry.attempt + 1,
          "retry poll failed"
        );
      } else {
        this.claimed.delete(issueId);
      }
      return;
    }

    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.claimed.delete(issueId);
      return;
    }

    if (!this.hasAvailableGlobalSlots() || !this.hasAvailableStateSlots(issue.state)) {
      this.scheduleRetry(issue, retryState.entry.attempt + 1, "no available orchestrator slots");
      return;
    }

    this.claimed.delete(issueId);
    if (this.shouldDispatch(issue)) {
      this.dispatchIssue(issue, retryState.entry.attempt);
      return;
    }

    this.claimed.delete(issueId);
  }

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return false;
    }

    if (!isActiveState(this.config, issue.state) || isTerminalState(this.config, issue.state)) {
      return false;
    }

    if (this.running.has(issue.id) || this.claimed.has(issue.id)) {
      return false;
    }

    if (!this.hasAvailableGlobalSlots() || !this.hasAvailableStateSlots(issue.state)) {
      return false;
    }

    if (normalizeStateName(issue.state) === "todo") {
      const hasNonTerminalBlocker = issue.blockedBy.some(
        (blocker) => blocker.state === null || !isTerminalState(this.config, blocker.state)
      );
      if (hasNonTerminalBlocker) {
        return false;
      }
    }

    return true;
  }

  private hasAvailableGlobalSlots(): boolean {
    return this.running.size < this.config.agent.maxConcurrentAgents;
  }

  private hasAvailableStateSlots(state: string): boolean {
    const normalized = normalizeStateName(state);
    const current = [...this.running.values()].filter(
      (entry) => normalizeStateName(entry.issue.state) === normalized
    ).length;
    return current < perStateConcurrencyLimit(this.config, state);
  }

  private toRunningRow(entry: RunningEntry): RuntimeSnapshot["running"][number] {
    return {
      issueId: entry.issue.id,
      issueIdentifier: entry.identifier,
      state: entry.issue.state,
      sessionId: entry.session.sessionId,
      turnCount: entry.session.turnCount,
      lastEvent: entry.session.lastCodexEvent,
      lastMessage: entry.session.lastCodexMessage,
      startedAt: entry.startedAt,
      lastEventAt: entry.session.lastCodexTimestamp,
      tokens: {
        inputTokens: entry.session.codexInputTokens,
        outputTokens: entry.session.codexOutputTokens,
        totalTokens: entry.session.codexTotalTokens
      }
    };
  }

  private ensureIssueTracking(issue: Issue): IssueTrackingState {
    const existing = this.issueTracking.get(issue.id);
    if (existing) {
      existing.issueIdentifier = issue.identifier;
      return existing;
    }

    const created: IssueTrackingState = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      workspacePath: null,
      restartCount: 0,
      currentRetryAttempt: null,
      lastError: null,
      recentEvents: []
    };
    this.issueTracking.set(issue.id, created);
    return created;
  }

  private nextAttempt(previousAttempt: number | null): number {
    return previousAttempt === null ? 1 : previousAttempt + 1;
  }

  private computeRuntimeSeconds(): number {
    const activeSeconds = [...this.running.values()].reduce((total, entry) => total + (Date.now() - entry.startedAtMs) / 1000, 0);
    return this.codexTotals.secondsRunning + activeSeconds;
  }

}

function emptySessionSnapshot(): LiveSessionSnapshot {
  return {
    sessionId: null,
    threadId: null,
    turnId: null,
    codexAppServerPid: null,
    lastCodexEvent: null,
    lastCodexTimestamp: null,
    lastCodexMessage: null,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    turnCount: 0
  };
}

function ensureSymphonyError(error: unknown, fallbackCode: string): SymphonyError {
  if (error instanceof SymphonyError) {
    return error;
  }

  return new SymphonyError(fallbackCode, error instanceof Error ? error.message : String(error));
}

function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreatedAt = left.createdAt ? Date.parse(left.createdAt) : Number.MAX_SAFE_INTEGER;
    const rightCreatedAt = right.createdAt ? Date.parse(right.createdAt) : Number.MAX_SAFE_INTEGER;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.identifier.localeCompare(right.identifier);
  });
}

function isTerminalSessionEvent(eventName: string): boolean {
  return (
    eventName === "turn_completed" ||
    eventName === "turn_failed" ||
    eventName === "turn_cancelled" ||
    eventName === "turn_input_required"
  );
}
