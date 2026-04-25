import os from "node:os";
import path from "node:path";

import { SymphonyError } from "./errors.js";
import type { EffectiveConfig, WorkflowDefinition } from "./types.js";
import { asObject, coerceInteger, coerceStringList, expandPathLike, normalizeStateName, resolveEnvBackedString } from "./utils.js";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

export function resolveEffectiveConfig(
  workflow: WorkflowDefinition,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    workflowPath?: string;
  }
): EffectiveConfig {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const workflowPath = options?.workflowPath ?? workflow.filePath;

  const root = workflow.config;
  const tracker = asObject(root.tracker);
  const polling = asObject(root.polling);
  const workspace = asObject(root.workspace);
  const hooks = asObject(root.hooks);
  const agent = asObject(root.agent);
  const codex = asObject(root.codex);
  const server = asObject(root.server);

  const trackerKind = typeof tracker.kind === "string" ? tracker.kind.trim().toLowerCase() : "";
  if (trackerKind !== "clickup") {
    throw new SymphonyError(
      "unsupported_tracker_kind",
      `Unsupported tracker.kind "${tracker.kind ?? ""}". Expected "clickup".`
    );
  }

  const trackerApiKey = resolveEnvBackedString(tracker.api_key ?? "$CLICKUP_API_TOKEN", env);
  if (!trackerApiKey) {
    throw new SymphonyError("missing_tracker_api_key", "tracker.api_key is required for ClickUp");
  }

  const workspaceId = resolveEnvBackedString(tracker.workspace_id, env);
  if (!workspaceId) {
    throw new SymphonyError("missing_tracker_workspace_id", "tracker.workspace_id is required for ClickUp");
  }

  const spaceIds = coerceStringList(tracker.space_ids);
  const folderIds = coerceStringList(tracker.folder_ids);
  const listIds = coerceStringList(tracker.list_ids);
  if (spaceIds.length === 0 && folderIds.length === 0 && listIds.length === 0) {
    throw new SymphonyError(
      "missing_tracker_scope_filters",
      "At least one of tracker.space_ids, tracker.folder_ids, or tracker.list_ids is required"
    );
  }

  const activeStates = uniqueStrings(coerceStringList(tracker.active_states), DEFAULT_ACTIVE_STATES);
  const terminalStates = uniqueStrings(coerceStringList(tracker.terminal_states), DEFAULT_TERMINAL_STATES);
  const hookTimeoutMs = positiveOrFallback(hooks.timeout_ms, 60_000);
  const maxConcurrentAgents = positiveOrFallback(agent.max_concurrent_agents, 10);
  const maxRetryBackoffMs = positiveOrFallback(agent.max_retry_backoff_ms, 300_000);
  const maxTurns = positiveOrFallback(agent.max_turns, 20);

  const stateConcurrency = normalizeStateConcurrency(agent.max_concurrent_agents_by_state);

  const workspaceRootRaw =
    resolveEnvBackedString(workspace.root ?? path.join(os.tmpdir(), "symphony_workspaces"), env) ??
    path.join(os.tmpdir(), "symphony_workspaces");

  const workspaceRoot = expandPathLike(workspaceRootRaw, env, cwd);
  const trackerEndpoint =
    resolveEnvBackedString(tracker.endpoint ?? "https://api.clickup.com/api/v2", env) ??
    "https://api.clickup.com/api/v2";

  const codexCommand =
    resolveEnvBackedString(codex.command ?? "codex app-server", env) ?? "codex app-server";
  if (codexCommand.trim() === "") {
    throw new SymphonyError("missing_codex_command", "codex.command must be present and non-empty");
  }

  return {
    workflowPath,
    tracker: {
      kind: "clickup",
      endpoint: trackerEndpoint,
      apiKey: trackerApiKey,
      workspaceId,
      spaceIds,
      folderIds,
      listIds,
      activeStates,
      activeStateSet: new Set(activeStates.map(normalizeStateName)),
      terminalStates,
      terminalStateSet: new Set(terminalStates.map(normalizeStateName))
    },
    polling: {
      intervalMs: positiveOrFallback(polling.interval_ms, 30_000)
    },
    workspace: {
      root: workspaceRoot
    },
    hooks: {
      afterCreate: optionalString(hooks.after_create),
      beforeRun: optionalString(hooks.before_run),
      afterRun: optionalString(hooks.after_run),
      beforeRemove: optionalString(hooks.before_remove),
      timeoutMs: hookTimeoutMs
    },
    agent: {
      maxConcurrentAgents,
      maxConcurrentAgentsByState: stateConcurrency,
      maxRetryBackoffMs,
      maxTurns
    },
    codex: {
      command: codexCommand,
      model: optionalString(codex.model),
      reasoningEffort: optionalString(firstDefined(codex.reasoning_effort, codex.effort)),
      personality: optionalString(codex.personality),
      serviceName: optionalString(firstDefined(codex.service_name, codex.serviceName)),
      approvalPolicy: codex.approval_policy ?? "never",
      threadSandbox: codex.thread_sandbox ?? "workspace-write",
      turnSandboxPolicy: codex.turn_sandbox_policy ?? { type: "workspace-write" },
      turnTimeoutMs: positiveOrFallback(codex.turn_timeout_ms, 3_600_000),
      readTimeoutMs: positiveOrFallback(codex.read_timeout_ms, 5_000),
      stallTimeoutMs: coerceInteger(codex.stall_timeout_ms, 300_000)
    },
    server: {
      port: parseOptionalPort(server.port)
    }
  };
}

export function validateDispatchConfig(config: EffectiveConfig): void {
  if (config.tracker.kind !== "clickup") {
    throw new SymphonyError("unsupported_tracker_kind", `Unsupported tracker.kind "${config.tracker.kind}"`);
  }

  if (!config.tracker.apiKey) {
    throw new SymphonyError("missing_tracker_api_key", "tracker.api_key is required");
  }

  if (!config.tracker.workspaceId) {
    throw new SymphonyError("missing_tracker_workspace_id", "tracker.workspace_id is required");
  }

  if (config.tracker.spaceIds.length === 0 && config.tracker.folderIds.length === 0 && config.tracker.listIds.length === 0) {
    throw new SymphonyError(
      "missing_tracker_scope_filters",
      "At least one ClickUp scope filter is required for dispatch"
    );
  }

  if (config.codex.command.trim() === "") {
    throw new SymphonyError("missing_codex_command", "codex.command must be present and non-empty");
  }
}

export function isActiveState(config: EffectiveConfig, state: string): boolean {
  return config.tracker.activeStateSet.has(normalizeStateName(state));
}

export function isTerminalState(config: EffectiveConfig, state: string): boolean {
  return config.tracker.terminalStateSet.has(normalizeStateName(state));
}

export function perStateConcurrencyLimit(config: EffectiveConfig, state: string): number {
  const normalized = normalizeStateName(state);
  return config.agent.maxConcurrentAgentsByState[normalized] ?? config.agent.maxConcurrentAgents;
}

function normalizeStateConcurrency(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = positiveOrFallback(raw, 0);
    if (parsed > 0) {
      result[normalizeStateName(key)] = parsed;
    }
  }

  return result;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function parseOptionalPort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const port = coerceInteger(value, -1);
  if (port < 0) {
    throw new SymphonyError("invalid_server_port", "server.port must be a non-negative integer");
  }

  return port;
}

function positiveOrFallback(value: unknown, fallback: number): number {
  const parsed = coerceInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function uniqueStrings(values: string[], fallback: string[]): string[] {
  const selected = values.length > 0 ? values : fallback;
  return [...new Set(selected)];
}
