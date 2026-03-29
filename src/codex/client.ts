import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import type { Logger } from "pino";

import type { DynamicToolHandler, DynamicToolSpec } from "./dynamic-tools.js";
import { SymphonyError } from "../errors.js";
import { resolveLoginShell } from "../shell.js";
import type { CodexConfig, LiveSessionEvent } from "../types.js";
import { createDeferred, nowIso } from "../utils.js";

const MAX_LINE_SIZE_BYTES = 10 * 1024 * 1024;

type JsonRpcId = number;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  deferred: ReturnType<typeof createDeferred<CodexTurnResult>>;
  timeout: NodeJS.Timeout;
}

type DynamicToolRegistrationField = "dynamicTools" | "dynamic_tools" | "tools";

interface ThreadStartOutcome {
  response: unknown;
  registrationField: DynamicToolRegistrationField | null;
}

export interface StartSessionOptions {
  workspacePath: string;
  onEvent: (event: LiveSessionEvent) => void;
}

export interface RunTurnOptions {
  prompt: string;
  title: string;
}

export interface CodexTurnResult {
  status: "completed" | "failed" | "cancelled";
  turnId: string;
  error: string | null;
}

export class CodexAppServerClient {
  private readonly logger: Logger;

  constructor(
    private readonly config: CodexConfig,
    logger: Logger,
    private readonly dynamicToolHandler: DynamicToolHandler | null = null
  ) {
    this.logger = logger.child({ component: "codex_app_server" });
  }

  async startSession(options: StartSessionOptions): Promise<CodexSession> {
    return CodexSession.start(this.config, this.logger, options, this.dynamicToolHandler);
  }
}

export class CodexSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly stderrChunks: string[] = [];
  private readonly onEvent: (event: LiveSessionEvent) => void;
  private readonly dynamicToolHandler: DynamicToolHandler | null;
  private readonly toolSpecs: DynamicToolSpec[];
  private nextId = 1;
  private stdoutBuffer = "";
  private activeTurn: ActiveTurn | null = null;
  private pendingTurnOutcome: CodexTurnResult | SymphonyError | null = null;
  private dynamicToolRegistrationField: DynamicToolRegistrationField | null = null;
  private activeTurnRequiresInput = false;
  private closed = false;
  private childExited = false;
  private readonly childExitPromise: Promise<void>;
  private readonly resolveChildExit: () => void;
  private threadId: string | null = null;
  private turnId: string | null = null;

  private constructor(
    private readonly config: CodexConfig,
    logger: Logger,
    child: ChildProcessWithoutNullStreams,
    readonly workspacePath: string,
    onEvent: (event: LiveSessionEvent) => void,
    dynamicToolHandler: DynamicToolHandler | null
  ) {
    this.child = child;
    this.onEvent = onEvent;
    this.dynamicToolHandler = dynamicToolHandler;
    this.toolSpecs = dynamicToolHandler?.listTools() ?? [];
    this.logger = logger.child({ workspace_path: workspacePath, pid: child.pid ?? null });

    let resolveChildExit!: () => void;
    this.childExitPromise = new Promise<void>((resolve) => {
      resolveChildExit = resolve;
    });
    this.resolveChildExit = resolveChildExit;
  }

  static async start(
    config: CodexConfig,
    logger: Logger,
    options: StartSessionOptions,
    dynamicToolHandler: DynamicToolHandler | null
  ): Promise<CodexSession> {
    const child = spawn(resolveLoginShell(), ["-c", config.command], {
      cwd: options.workspacePath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const session = new CodexSession(config, logger, child, options.workspacePath, options.onEvent, dynamicToolHandler);
    session.startReaders();
    await session.initialize();
    return session;
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get currentSessionId(): string | null {
    return this.threadId && this.turnId ? `${this.threadId}-${this.turnId}` : null;
  }

  async runTurn(options: RunTurnOptions): Promise<CodexTurnResult> {
    if (this.closed) {
      throw new SymphonyError("port_exit", "Codex session is already closed");
    }

    if (!this.threadId) {
      throw new SymphonyError("response_error", "Codex thread is not initialized");
    }

    if (this.activeTurn) {
      throw new SymphonyError("response_error", "A Codex turn is already active for this session");
    }

    const response = await this.request("turn/start", {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: options.prompt
        }
      ],
      cwd: this.workspacePath,
      title: options.title,
      approvalPolicy: this.config.approvalPolicy,
      sandboxPolicy: materializeTurnSandboxPolicy(this.config.turnSandboxPolicy, this.workspacePath)
    });

    this.turnId = extractTurnId(response);
    this.emit({
      event: "session_started",
      turnId: this.turnId,
      sessionId: this.currentSessionId,
      message: options.title
    });

    const deferred = createDeferred<CodexTurnResult>();
    const timeout = setTimeout(() => {
      deferred.reject(new SymphonyError("turn_timeout", `Codex turn timed out after ${this.config.turnTimeoutMs}ms`));
    }, this.config.turnTimeoutMs);

    this.activeTurnRequiresInput = false;
    this.activeTurn = { deferred, timeout };

    if (this.pendingTurnOutcome) {
      const pendingOutcome = this.pendingTurnOutcome;
      this.pendingTurnOutcome = null;
      if (pendingOutcome instanceof SymphonyError) {
        this.failActiveTurn(pendingOutcome);
      } else {
        this.completeActiveTurn(this.resolveTurnOutcome(pendingOutcome));
      }
    }

    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
      this.activeTurn = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new SymphonyError("port_exit", `Codex session closed before response ${id}`));
    }
    this.pendingRequests.clear();

    if (this.activeTurn) {
      clearTimeout(this.activeTurn.timeout);
      this.activeTurn.deferred.reject(new SymphonyError("port_exit", "Codex session closed during active turn"));
      this.activeTurn = null;
    }

    if (!this.childExited) {
      this.child.kill("SIGTERM");
    }

    await Promise.race([
      this.childExitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ]);

    if (!this.childExited) {
      this.child.kill("SIGKILL");
      await Promise.race([
        this.childExitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "symphony",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.notify("initialized", {});

    const threadStart = await this.startThread();

    this.threadId = extractThreadId(threadStart.response);
    this.dynamicToolRegistrationField = threadStart.registrationField;
    if (this.toolSpecs.length > 0) {
      this.emit({
        event: this.dynamicToolRegistrationField ? "dynamic_tools_advertised" : "dynamic_tools_unavailable",
        message: this.dynamicToolRegistrationField,
        raw: {
          registrationField: this.dynamicToolRegistrationField,
          toolCount: this.toolSpecs.length
        }
      });
    }
  }

  private async startThread(): Promise<ThreadStartOutcome> {
    const baseParams: Record<string, unknown> = {
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.threadSandbox,
      cwd: this.workspacePath,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };

    if (this.toolSpecs.length === 0) {
      return {
        response: await this.request("thread/start", baseParams),
        registrationField: null
      };
    }

    for (const registrationField of ["dynamicTools", "dynamic_tools", "tools"] as const) {
      try {
        return {
          response: await this.request("thread/start", {
            ...baseParams,
            [registrationField]: this.toolSpecs
          }),
          registrationField
        };
      } catch (error) {
        this.logger.warn(
          {
            registration_field: registrationField,
            tool_count: this.toolSpecs.length,
            error: error instanceof Error ? error.message : String(error)
          },
          "thread_start_with_dynamic_tools_failed"
        );
      }
    }

    return {
      response: await this.request("thread/start", baseParams),
      registrationField: null
    };
  }

  private startReaders(): void {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      if (this.stdoutBuffer.length > MAX_LINE_SIZE_BYTES) {
        this.failCurrentWork(new SymphonyError("response_error", "Codex stdout line exceeded max buffer size"));
        return;
      }

      this.processBufferedStdout();
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const text = String(chunk);
      this.stderrChunks.push(text);
      if (this.stderrChunks.length > 20) {
        this.stderrChunks.shift();
      }
      this.logger.debug({ stderr: truncateMessage(text) }, "codex_stderr");
    });

    this.child.on("error", (error) => {
      this.failCurrentWork(new SymphonyError("port_exit", `Codex process error: ${error.message}`, undefined, error));
    });

    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      this.resolveChildExit();

      if (this.closed) {
        return;
      }

      const stderrSummary = summarizeStderr(this.stderrChunks);
      this.failCurrentWork(
        new SymphonyError(
          "port_exit",
          `Codex process exited with code ${code ?? "null"} signal ${signal ?? "null"}${stderrSummary ? `: ${stderrSummary}` : ""}`
        )
      );
    });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const deferred = createDeferred<unknown>();
    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
      deferred.reject(new SymphonyError("response_timeout", `Timed out waiting for ${method} response`));
    }, this.config.readTimeoutMs);

    this.pendingRequests.set(id, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer
    });

    this.writeMessage({ id, method, params });
    return deferred.promise;
  }

  private notify(method: string, params?: unknown): void {
    this.writeMessage({ method, params });
  }

  private writeMessage(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private processBufferedStdout(): void {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (rawLine === "") {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        this.emit({
          event: "malformed",
          message: truncateMessage(rawLine),
          raw: rawLine
        });
        continue;
      }

      this.handleMessage(parsed);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);

      if ("error" in message && message.error !== undefined) {
        pending.reject(
          new SymphonyError("response_error", `Codex responded with an error for request ${message.id}`, {
            error: message.error
          })
        );
      } else {
        pending.resolve(message.result);
      }

      return;
    }

    if (typeof message.method === "string" && typeof message.id === "number") {
      void this.handleServerRequest(message.method, message.id, message.params);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params, message);
    }
  }

  private async handleServerRequest(method: string, id: number, params: unknown): Promise<void> {
    const normalizedMethod = method.toLowerCase();

    if (normalizedMethod.includes("approval")) {
      this.writeMessage({
        id,
        result: {
          approved: true
        }
      });
      this.emit({
        event: "approval_auto_approved",
        message: method,
        raw: params
      });
      return;
    }

    if (normalizedMethod.includes("requestuserinput")) {
      this.writeMessage({
        id,
        result: buildToolRequestUserInputResponse(params)
      });
      this.activeTurnRequiresInput = true;
      this.emit({
        event: "turn_input_required",
        message: method,
        raw: params
      });
      return;
    }

    if (normalizedMethod.includes("tool/call")) {
      const toolResponse = await this.handleDynamicToolCall(params);
      if (toolResponse) {
        this.writeMessage({
          id,
          result: toolResponse
        });
        this.emit({
          event: "dynamic_tool_call_completed",
          message: method,
          raw: {
            params,
            success: toolResponse.success
          }
        });
        return;
      }

      this.writeMessage({
        id,
        result: unsupportedToolCallResult()
      });
      this.emit({
        event: "unsupported_tool_call",
        message: method,
        raw: params
      });
      return;
    }

    this.writeMessage({
      id,
      result: {
        success: false,
        error: "unsupported_request"
      }
    });
  }

  private async handleDynamicToolCall(params: unknown): Promise<Record<string, unknown> | null> {
    if (!this.dynamicToolHandler || !params || typeof params !== "object" || Array.isArray(params)) {
      return null;
    }

    const tool = (params as { tool?: unknown }).tool;
    const args = (params as { arguments?: unknown }).arguments;
    if (typeof tool !== "string" || tool.trim() === "") {
      return null;
    }

    const result = await this.dynamicToolHandler.callTool(tool, args);
    if (!result) {
      return null;
    }

    return result as unknown as Record<string, unknown>;
  }

  private handleNotification(method: string, params: unknown, raw: unknown): void {
    const usage = extractUsage(raw);
    const rateLimits = extractRateLimits(raw);
    const message = extractMessage(params);
    const eventPayload: Omit<LiveSessionEvent, "timestamp" | "codexAppServerPid" | "threadId"> = {
      event: method.replaceAll("/", "_"),
      turnId: this.turnId,
      message,
      raw
    };

    if (usage) {
      eventPayload.usage = usage;
    }

    if (rateLimits) {
      eventPayload.rateLimits = rateLimits;
    }

    this.emit(eventPayload);

    const normalizedMethod = method.toLowerCase();
    if (normalizedMethod === "turn/completed") {
      this.activeTurnRequiresInput = false;
      this.completeActiveTurn({
        status: "completed",
        turnId: this.turnId ?? "unknown",
        error: null
      });
      return;
    }

    if (normalizedMethod === "turn/failed") {
      const errorMessage =
        this.activeTurnRequiresInput && (!message || message.trim() === "")
          ? "Interactive input required"
          : message ?? "Codex reported turn failure";
      this.activeTurnRequiresInput = false;
      this.completeActiveTurn({
        status: "failed",
        turnId: this.turnId ?? "unknown",
        error: errorMessage
      });
      return;
    }

    if (normalizedMethod === "turn/cancelled") {
      this.activeTurnRequiresInput = false;
      this.completeActiveTurn({
        status: "cancelled",
        turnId: this.turnId ?? "unknown",
        error: message ?? "Codex reported turn cancellation"
      });
      return;
    }

    if (normalizedMethod.includes("requestuserinput")) {
      this.activeTurnRequiresInput = true;
    }
  }

  private emit(event: Omit<LiveSessionEvent, "timestamp" | "codexAppServerPid" | "threadId">): void {
    this.onEvent({
      timestamp: nowIso(),
      codexAppServerPid: this.pid,
      threadId: this.threadId,
      ...event
    });
  }

  private completeActiveTurn(result: CodexTurnResult): void {
    this.activeTurnRequiresInput = false;
    const resolvedResult = this.resolveTurnOutcome(result);

    if (!this.activeTurn) {
      this.pendingTurnOutcome = resolvedResult;
      return;
    }

    this.activeTurn.deferred.resolve(resolvedResult);
  }

  private failActiveTurn(error: SymphonyError): void {
    this.activeTurnRequiresInput = false;
    if (!this.activeTurn) {
      this.pendingTurnOutcome = error;
      return;
    }

    clearTimeout(this.activeTurn.timeout);
    this.activeTurn.deferred.reject(error);
  }

  private failCurrentWork(error: SymphonyError): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.failActiveTurn(error);
  }

  private resolveTurnOutcome(result: CodexTurnResult): CodexTurnResult {
    if (result.turnId !== "unknown" || !this.turnId) {
      return result;
    }

    return {
      ...result,
      turnId: this.turnId
    };
  }
}

function extractThreadId(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as { thread?: { id?: unknown } }).thread?.id === "string"
  ) {
    return (result as { thread: { id: string } }).thread.id;
  }

  throw new SymphonyError("response_error", "Codex thread/start response did not include result.thread.id");
}

function extractTurnId(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as { turn?: { id?: unknown } }).turn?.id === "string"
  ) {
    return (result as { turn: { id: string } }).turn.id;
  }

  throw new SymphonyError("response_error", "Codex turn/start response did not include result.turn.id");
}

function unsupportedToolCallResult(): Record<string, unknown> {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ error: "unsupported_tool_call" })
      }
    ]
  };
}

function extractMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  for (const key of ["message", "summary", "text", "reason", "status"]) {
    const candidate = objectValue[key];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return truncateMessage(candidate);
    }
  }

  return null;
}

function extractUsage(value: unknown): LiveSessionEvent["usage"] | undefined {
  const absolute = findNestedObject(value, (candidate) => {
    const keys = Object.keys(candidate);
    return (
      keys.includes("total_token_usage") ||
      keys.includes("input_tokens") ||
      keys.includes("inputTokens") ||
      keys.includes("total_tokens") ||
      keys.includes("totalTokens")
    );
  });

  if (!absolute) {
    return undefined;
  }

  const container =
    absolute.total_token_usage && typeof absolute.total_token_usage === "object"
      ? (absolute.total_token_usage as Record<string, unknown>)
      : absolute;

  const inputTokens = readNumericField(container, ["input_tokens", "inputTokens"]);
  const outputTokens = readNumericField(container, ["output_tokens", "outputTokens"]);
  const totalTokens = readNumericField(container, ["total_tokens", "totalTokens"]);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return undefined;
  }

  const usage: NonNullable<LiveSessionEvent["usage"]> = {};
  if (inputTokens !== null) {
    usage.inputTokens = inputTokens;
  }
  if (outputTokens !== null) {
    usage.outputTokens = outputTokens;
  }
  if (totalTokens !== null) {
    usage.totalTokens = totalTokens;
  }

  return usage;
}

function extractRateLimits(value: unknown): Record<string, unknown> | null {
  return findNestedObject(value, (candidate) => {
    const keys = Object.keys(candidate).map((key) => key.toLowerCase());
    return keys.some((key) => key.includes("rate") && key.includes("limit"));
  });
}

function findNestedObject(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedObject(item, predicate, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (predicate(candidate)) {
    return candidate;
  }

  for (const nested of Object.values(candidate)) {
    const found = findNestedObject(nested, predicate, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function readNumericField(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string" && candidate.trim() !== "") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function truncateMessage(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function summarizeStderr(chunks: string[]): string | null {
  const combined = chunks.join("").trim();
  if (combined === "") {
    return null;
  }

  const compact = combined.replace(/\s+/g, " ").trim();
  return truncateMessage(compact);
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

export function materializeTurnSandboxPolicy(policy: unknown, workspacePath: string): unknown {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return policy;
  }

  const raw = policy as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : null;
  if (type === "workspaceWrite" || type === "workspace-write") {
    const writableRoots = normalizeWritableRoots(
      firstDefined(raw.writableRoots, raw.writable_roots),
      workspacePath
    );

    return {
      type: "workspaceWrite",
      writableRoots,
      readOnlyAccess: normalizeReadOnlyAccess(
        firstDefined(raw.readOnlyAccess, raw.read_only_access),
        workspacePath
      ),
      networkAccess: normalizeWorkspaceWriteNetworkAccess(
        firstDefined(raw.networkAccess, raw.network_access)
      ),
      excludeTmpdirEnvVar: normalizeBoolean(
        firstDefined(raw.excludeTmpdirEnvVar, raw.exclude_tmpdir_env_var),
        false
      ),
      excludeSlashTmp: normalizeBoolean(firstDefined(raw.excludeSlashTmp, raw.exclude_slash_tmp), false)
    };
  }

  if (type === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (type === "readOnly" || type === "read-only") {
    return {
      type: "readOnly",
      access: normalizeReadOnlyAccess(firstDefined(raw.access, raw.readOnlyAccess, raw.read_only_access), workspacePath),
      networkAccess: normalizeBoolean(firstDefined(raw.networkAccess, raw.network_access), false)
    };
  }

  return policy;
}

function normalizeWritableRoots(rawRoots: unknown, workspacePath: string): string[] {
  const normalized = new Set<string>();
  const add = (candidate: string) => {
    const resolved = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(workspacePath, candidate);
    normalized.add(resolved);
  };

  if (Array.isArray(rawRoots)) {
    for (const root of rawRoots) {
      if (typeof root === "string" && root.trim() !== "") {
        add(root.trim());
      }
    }
  }

  add(workspacePath);
  add(path.join(workspacePath, ".git"));
  return [...normalized];
}

function normalizeReadOnlyAccess(rawAccess: unknown, workspacePath: string): Record<string, unknown> {
  if (!rawAccess || typeof rawAccess !== "object" || Array.isArray(rawAccess)) {
    return { type: "fullAccess" };
  }

  const access = rawAccess as Record<string, unknown>;
  const type = typeof access.type === "string" ? access.type : null;
  if (type === "restricted") {
    const readableRoots = Array.isArray(firstDefined(access.readableRoots, access.readable_roots))
      ? (firstDefined(access.readableRoots, access.readable_roots) as unknown[])
          .filter((root): root is string => typeof root === "string" && root.trim() !== "")
          .map((root) => (path.isAbsolute(root) ? path.normalize(root) : path.resolve(workspacePath, root)))
      : [];

    return {
      type: "restricted",
      includePlatformDefaults: normalizeBoolean(
        firstDefined(access.includePlatformDefaults, access.include_platform_defaults),
        true
      ),
      readableRoots
    };
  }

  return { type: "fullAccess" };
}

function normalizeWorkspaceWriteNetworkAccess(value: unknown): boolean {
  if (value === "enabled") {
    return true;
  }

  if (value === "restricted") {
    return false;
  }

  return normalizeBoolean(value, true);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function buildToolRequestUserInputResponse(params: unknown): Record<string, unknown> {
  const questions = extractRequestUserInputQuestions(params);
  if (questions.length === 0) {
    return { answers: {} };
  }

  return {
    answers: Object.fromEntries(
      questions.map((questionId) => [
        questionId,
        {
          answers: []
        }
      ])
    )
  };
}

function extractRequestUserInputQuestions(params: unknown): string[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }

  const rawQuestions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  return rawQuestions
    .map((question) => {
      if (!question || typeof question !== "object" || Array.isArray(question)) {
        return null;
      }

      const questionId = (question as { id?: unknown }).id;
      return typeof questionId === "string" && questionId.trim() !== "" ? questionId : null;
    })
    .filter((questionId): questionId is string => questionId !== null);
}
