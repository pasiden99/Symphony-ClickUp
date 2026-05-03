import * as fs from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type {
  AuditConfig,
  AuditEvent,
  AuditEventInput,
  AuditEventPage,
  AuditEventQuery,
  AuditSummary
} from "./types.js";
import { nowIso } from "./utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 1_000;

interface AuditFs {
  appendFile: typeof fs.appendFile;
  mkdir: typeof fs.mkdir;
  readdir: typeof fs.readdir;
  readFile: typeof fs.readFile;
  rm: typeof fs.rm;
}

export interface AuditRecorder {
  initialize(): Promise<void>;
  updateConfig(config: AuditConfig): void;
  record(input: AuditEventInput): Promise<AuditEvent | null>;
  query(query?: AuditEventQuery): AuditEventPage;
  getSummary(): AuditSummary;
  subscribe(listener: (event: AuditEvent) => void): () => void;
  flush(): Promise<void>;
}

export class JsonlAuditStore implements AuditRecorder {
  private readonly logger: Logger;
  private readonly listeners = new Set<(event: AuditEvent) => void>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private recentEvents: AuditEvent[] = [];
  private sequence = 0;

  constructor(private config: AuditConfig, logger: Logger, private readonly fsOps: AuditFs = fs) {
    this.logger = logger.child({ component: "audit_store" });
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      await this.fsOps.mkdir(this.config.outputDir, { recursive: true });
      await this.cleanupRetention();
      await this.loadRecentFromDisk();
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), output_dir: this.config.outputDir },
        "audit_store_initialize_failed"
      );
    }
  }

  updateConfig(config: AuditConfig): void {
    this.config = config;
    this.trimRecentEvents();
  }

  async record(input: AuditEventInput): Promise<AuditEvent | null> {
    if (!this.config.enabled) {
      return null;
    }

    let event: AuditEvent;
    try {
      event = this.boundEvent(this.createEvent(input));
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "audit_event_create_failed"
      );
      return null;
    }
    this.pushRecentEvent(event);
    this.notify(event);

    const write = this.appendEvent(event)
      .catch((error) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error), output_dir: this.config.outputDir },
          "audit_event_append_failed"
        );
      })
      .finally(() => {
        this.pendingWrites.delete(write);
      });

    this.pendingWrites.add(write);
    await write;
    return event;
  }

  query(query: AuditEventQuery = {}): AuditEventPage {
    const limit = normalizeLimit(query.limit);
    const q = query.q?.trim().toLowerCase() ?? "";
    const events = [...this.recentEvents]
      .reverse()
      .filter((event) => {
        if (query.issueIdentifier && event.issueIdentifier !== query.issueIdentifier) {
          return false;
        }
        if (query.category && event.category !== query.category) {
          return false;
        }
        if (query.level && event.level !== query.level) {
          return false;
        }
        if (q && !auditEventMatchesText(event, q)) {
          return false;
        }
        return true;
      });

    return {
      generatedAt: nowIso(),
      events: events.slice(0, limit),
      total: events.length,
      limit
    };
  }

  getSummary(): AuditSummary {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const failedRecentCount = this.recentEvents.filter((event) => {
      if (!isFailedDispatchEvent(event)) {
        return false;
      }

      const parsed = Date.parse(event.at);
      return Number.isFinite(parsed) && parsed >= oneHourAgo;
    }).length;

    return {
      enabled: this.config.enabled,
      recentCount: this.recentEvents.length,
      errorCount: this.recentEvents.filter((event) => event.level === "error").length,
      warnCount: this.recentEvents.filter((event) => event.level === "warn").length,
      failedRecentCount,
      lastEventAt: this.recentEvents.at(-1)?.at ?? null
    };
  }

  subscribe(listener: (event: AuditEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingWrites]);
  }

  private createEvent(input: AuditEventInput): AuditEvent {
    return {
      id: `audit-${Date.now().toString(36)}-${(this.sequence += 1).toString(36)}`,
      at: input.at ?? nowIso(),
      level: input.level,
      category: input.category,
      action: input.action,
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.issueIdentifier ? { issueIdentifier: input.issueIdentifier } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.data ? { data: input.data } : {})
    };
  }

  private boundEvent(event: AuditEvent): AuditEvent {
    let bounded = event;
    if (eventByteLength(bounded) <= this.config.maxEventBytes) {
      return bounded;
    }

    bounded = {
      ...bounded,
      data: bounded.data
        ? {
            truncated: true,
            originalDataKeys: Object.keys(bounded.data)
          }
        : { truncated: true }
    };
    if (eventByteLength(bounded) <= this.config.maxEventBytes) {
      return bounded;
    }

    if (bounded.message && bounded.message.length > 160) {
      bounded = {
        ...bounded,
        message: `${bounded.message.slice(0, 157)}...`
      };
    }
    if (eventByteLength(bounded) <= this.config.maxEventBytes) {
      return bounded;
    }

    const finalEvent: AuditEvent = {
      ...bounded,
      data: { truncated: true }
    };
    if (bounded.message !== undefined) {
      finalEvent.message = bounded.message ? bounded.message.slice(0, 64) : bounded.message;
    }
    return finalEvent;
  }

  private pushRecentEvent(event: AuditEvent): void {
    this.recentEvents.push(event);
    this.trimRecentEvents();
  }

  private trimRecentEvents(): void {
    const max = Math.max(1, this.config.maxRecentEvents);
    if (this.recentEvents.length <= max) {
      return;
    }

    this.recentEvents = this.recentEvents.slice(-max);
  }

  private notify(event: AuditEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "audit_event_listener_failed"
        );
      }
    }
  }

  private async appendEvent(event: AuditEvent): Promise<void> {
    await this.fsOps.mkdir(this.config.outputDir, { recursive: true });
    const filePath = path.join(this.config.outputDir, `${event.at.slice(0, 10)}.jsonl`);
    await this.fsOps.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async loadRecentFromDisk(): Promise<void> {
    let fileNames: string[];
    try {
      fileNames = await this.fsOps.readdir(this.config.outputDir);
    } catch {
      return;
    }

    const events: AuditEvent[] = [];
    for (const fileName of fileNames.filter(isAuditFileName).sort()) {
      const filePath = path.join(this.config.outputDir, fileName);
      let content: string;
      try {
        content = await this.fsOps.readFile(filePath, "utf8");
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error), file_path: filePath },
          "audit_file_read_failed"
        );
        continue;
      }

      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as unknown;
          if (isAuditEvent(parsed)) {
            events.push(parsed);
          }
        } catch {
          this.logger.warn({ file_path: filePath }, "audit_file_malformed_line_ignored");
        }
      }
    }

    this.recentEvents = events
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .slice(-Math.max(1, this.config.maxRecentEvents));
  }

  private async cleanupRetention(): Promise<void> {
    if (this.config.retentionDays <= 0) {
      return;
    }

    let fileNames: string[];
    try {
      fileNames = await this.fsOps.readdir(this.config.outputDir);
    } catch {
      return;
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const cutoffMs = startOfToday.getTime() - this.config.retentionDays * DAY_MS;

    await Promise.allSettled(
      fileNames.filter(isAuditFileName).map(async (fileName) => {
        const fileDate = Date.parse(fileName.slice(0, 10));
        if (!Number.isFinite(fileDate) || fileDate >= cutoffMs) {
          return;
        }

        await this.fsOps.rm(path.join(this.config.outputDir, fileName), { force: true });
      })
    );
  }
}

export function createNoopAuditRecorder(): AuditRecorder {
  return {
    async initialize() {
      return undefined;
    },
    updateConfig() {
      return undefined;
    },
    async record() {
      return null;
    },
    query(query: AuditEventQuery = {}) {
      const limit = normalizeLimit(query.limit);
      return {
        generatedAt: nowIso(),
        events: [],
        total: 0,
        limit
      };
    },
    getSummary() {
      return {
        enabled: false,
        recentCount: 0,
        errorCount: 0,
        warnCount: 0,
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

function normalizeLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_QUERY_LIMIT;
  }

  return Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.trunc(value)));
}

function auditEventMatchesText(event: AuditEvent, query: string): boolean {
  const haystack = [
    event.action,
    event.category,
    event.level,
    event.issueIdentifier,
    event.message,
    event.sessionId,
    event.threadId,
    event.turnId,
    event.workspacePath
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function eventByteLength(event: AuditEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function isAuditFileName(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(value);
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const event = value as AuditEvent;
  return (
    typeof event.id === "string" &&
    typeof event.at === "string" &&
    typeof event.level === "string" &&
    typeof event.category === "string" &&
    typeof event.action === "string"
  );
}

function isFailedDispatchEvent(event: AuditEvent): boolean {
  if (event.action !== "dispatch_finished" || event.level !== "error") {
    return false;
  }

  const status = event.data?.status;
  return status === "failed" || status === "timed_out" || status === "stalled";
}
