export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinition {
  filePath: string;
  config: Record<string, unknown>;
  promptTemplate: string;
  loadedAt: string;
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HookConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxRetryBackoffMs: number;
  maxTurns: number;
}

export interface CodexConfig {
  command: string;
  model?: string | null;
  reasoningEffort?: string | null;
  personality?: string | null;
  serviceName?: string | null;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ScreenshotConfig {
  enabled: boolean;
  outputDir: string;
  maxFilesPerAttempt: number;
  maxFileBytes: number;
}

export interface ClickUpTrackerConfig {
  kind: "clickup";
  endpoint: string;
  apiKey: string;
  workspaceId: string;
  spaceIds: string[];
  folderIds: string[];
  listIds: string[];
  activeStates: string[];
  activeStateSet: Set<string>;
  terminalStates: string[];
  terminalStateSet: Set<string>;
}

export interface ServerConfig {
  port: number | null;
}

export interface EffectiveConfig {
  workflowPath: string;
  tracker: ClickUpTrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HookConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  screenshots: ScreenshotConfig;
  server: ServerConfig;
}

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export type WorkerTerminalStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "timed_out"
  | "stalled"
  | "canceled_by_reconciliation";

export interface RunAttemptResult {
  status: WorkerTerminalStatus;
  issue: Issue;
  attempt: number | null;
  workspacePath: string;
  error: string | null;
  turnCount: number;
}

export interface LiveSessionEvent {
  event: string;
  timestamp: string;
  codexAppServerPid?: number | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  message?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  rateLimits?: Record<string, unknown> | null;
  raw?: unknown;
}

export interface LiveSessionSnapshot {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: string | null;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface RuntimeTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface RunningSnapshotRow {
  issueId: string;
  issueIdentifier: string;
  state: string;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string | null;
  lastMessage: string | null;
  startedAt: string;
  lastEventAt: string | null;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface RetrySnapshotRow {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  dueAt: string;
  error: string | null;
}

export interface RuntimeSnapshot {
  generatedAt: string;
  counts: {
    running: number;
    retrying: number;
  };
  running: RunningSnapshotRow[];
  retrying: RetrySnapshotRow[];
  codexTotals: RuntimeTotals;
  rateLimits: Record<string, unknown> | null;
  workflow: {
    path: string;
    promptTemplateEmpty: boolean;
  };
  lastConfigError: {
    code: string;
    message: string;
  } | null;
}

export interface IssueRuntimeSnapshot {
  issueIdentifier: string;
  issueId: string;
  status: "running" | "retrying" | "blocked" | "claimed" | "released" | "unknown";
  workspace: {
    path: string;
  };
  attempts: {
    restartCount: number;
    currentRetryAttempt: number | null;
  };
  running: RunningSnapshotRow | null;
  retry: RetrySnapshotRow | null;
  lastError: string | null;
  recentEvents: Array<{
    at: string;
    event: string;
    message: string | null;
  }>;
  tracked: Record<string, unknown>;
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}
