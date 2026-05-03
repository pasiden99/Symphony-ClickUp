import type { Readable } from "node:stream";
import vm from "node:vm";

import { afterEach, describe, expect, test } from "vitest";

import { createHttpServer } from "../src/http.js";
import { createLogger } from "../src/logging.js";
import type { AuditEvent, AuditEventPage, AuditEventQuery, RuntimeSnapshot } from "../src/types.js";

describe("http server", () => {
  const apps: Array<ReturnType<typeof createHttpServer>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test("renders the dashboard as html", async () => {
    const app = createHttpServer(createFakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).toContain("Symphony Runtime");
    expect(response.body).toContain("Audit Timeline");
    expect(response.body).toContain('id="audit-detail-back"');
    expect(response.body).toContain("EventSource('/api/v1/events')");
  });

  test("boots the live dashboard client and opens the sse stream", async () => {
    const app = createHttpServer(createFakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/"
    });

    const scriptMatch = response.body.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch?.[1]).toBeTruthy();

    let openedUrl: string | null = null;
    const elements = new Map<string, { textContent?: string; innerHTML?: string }>();

    const FakeEventSource = function (this: Record<string, unknown>, url: string) {
      openedUrl = url;
      this.addEventListener = () => undefined;
      this.close = () => undefined;
    } as unknown as { new (url: string): EventSource };

    const context = {
      window: { EventSource: FakeEventSource },
      EventSource: FakeEventSource,
      document: {
        body: {
          dataset: {}
        },
        getElementById(id: string) {
          if (!elements.has(id)) {
            elements.set(id, {});
          }

          return elements.get(id);
        }
      },
      JSON,
      Number,
      String
    };

    vm.runInNewContext(scriptMatch![1], context);

    expect(openedUrl).toBe("/api/v1/events");
  });

  test("suppresses favicon noise", async () => {
    const app = createHttpServer(createFakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/favicon.ico"
    });

    expect(response.statusCode).toBe(204);
  });

  test("streams snapshots over sse", async () => {
    const orchestrator = createFakeOrchestrator();
    const app = createHttpServer(orchestrator, createLogger({ enabled: false }));
    apps.push(app);
    let stream: Readable | null = null;

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/events",
        payloadAsStream: true
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.headers["cache-control"]).toContain("no-cache");

      const activeStream = response.stream();
      stream = activeStream;
      const collector = createStreamCollector(activeStream);

      const initialChunk = await collector.waitFor('"generatedAt":"2026-03-08T00:00:00.000Z"');
      expect(initialChunk).toContain("event: snapshot");

      orchestrator.emitRuntimeSnapshot(updatedSnapshot());
      const updateChunk = await collector.waitFor('"issueIdentifier":"ENG-9"');
      expect(updateChunk).toContain('"running":1');
    } finally {
      stream?.destroy();
    }
  });

  test("returns filtered audit events", async () => {
    const app = createHttpServer(createFakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit?level=error&q=workspace"
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as AuditEventPage;
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]?.action).toBe("workspace_cleanup_failed");
  });

  test("returns per-issue audit events", async () => {
    const app = createHttpServer(createFakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ENG-9/audit"
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as AuditEventPage;
    expect(payload.events.every((event) => event.issueIdentifier === "ENG-9")).toBe(true);
  });

  test("streams audit events over sse", async () => {
    const orchestrator = createFakeOrchestrator();
    const app = createHttpServer(orchestrator, createLogger({ enabled: false }));
    apps.push(app);
    let stream: Readable | null = null;

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/events",
        payloadAsStream: true
      });

      const activeStream = response.stream();
      stream = activeStream;
      const collector = createStreamCollector(activeStream);

      orchestrator.emitAuditEvent({
        ...baseAuditEvents()[0]!,
        id: "audit-new",
        action: "retry_scheduled"
      });

      const updateChunk = await collector.waitFor('"action":"retry_scheduled"');
      expect(updateChunk).toContain("event: audit");
    } finally {
      stream?.destroy();
    }
  });
});

function createFakeOrchestrator(initialSnapshot: RuntimeSnapshot = baseSnapshot()) {
  let snapshot = initialSnapshot;
  let auditEvents = baseAuditEvents();
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  const auditListeners = new Set<(event: AuditEvent) => void>();

  return {
    getRuntimeSnapshot() {
      return snapshot;
    },
    getIssueSnapshot() {
      return null;
    },
    getAuditEvents(query: AuditEventQuery = {}) {
      let events = [...auditEvents];
      if (query.issueIdentifier) {
        events = events.filter((event) => event.issueIdentifier === query.issueIdentifier);
      }
      if (query.level) {
        events = events.filter((event) => event.level === query.level);
      }
      if (query.category) {
        events = events.filter((event) => event.category === query.category);
      }
      if (query.q) {
        const q = query.q.toLowerCase();
        events = events.filter((event) => `${event.action} ${event.message ?? ""}`.toLowerCase().includes(q));
      }
      const limit = query.limit ?? 200;
      return {
        generatedAt: new Date("2026-03-08T00:00:02.000Z").toISOString(),
        events: events.slice(0, limit),
        total: events.length,
        limit
      };
    },
    async requestRefresh() {
      return {
        queued: true,
        coalesced: false
      };
    },
    subscribeRuntimeSnapshots(listener: (nextSnapshot: RuntimeSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeAuditEvents(listener: (event: AuditEvent) => void) {
      auditListeners.add(listener);
      return () => {
        auditListeners.delete(listener);
      };
    },
    emitRuntimeSnapshot(nextSnapshot: RuntimeSnapshot) {
      snapshot = nextSnapshot;
      for (const listener of [...listeners]) {
        listener(snapshot);
      }
    },
    emitAuditEvent(event: AuditEvent) {
      auditEvents = [event, ...auditEvents];
      for (const listener of [...auditListeners]) {
        listener(event);
      }
    }
  };
}

function baseSnapshot(): RuntimeSnapshot {
  return {
    generatedAt: new Date("2026-03-08T00:00:00.000Z").toISOString(),
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0
    },
    running: [],
    retrying: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0
    },
    audit: {
      enabled: true,
      recentCount: 2,
      errorCount: 1,
      warnCount: 0,
      failedRecentCount: 1,
      lastEventAt: new Date("2026-03-08T00:00:01.000Z").toISOString()
    },
    rateLimits: null,
    workflow: {
      path: "/tmp/WORKFLOW.md",
      promptTemplateEmpty: false
    },
    lastConfigError: null
  };
}

function updatedSnapshot(): RuntimeSnapshot {
  return {
    ...baseSnapshot(),
    generatedAt: new Date("2026-03-08T00:00:01.000Z").toISOString(),
    counts: {
      running: 1,
      retrying: 0,
      blocked: 0
    },
    running: [
      {
        issueId: "9",
        issueIdentifier: "ENG-9",
        state: "In Progress",
        attempt: null,
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        turnCount: 2,
        lastEvent: "turn_completed",
        lastMessage: "Validation passed",
        startedAt: new Date("2026-03-08T00:00:00.000Z").toISOString(),
        lastEventAt: new Date("2026-03-08T00:00:01.000Z").toISOString(),
        workspacePath: "/tmp/ws/ENG-9",
        tokens: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20
        }
      }
    ]
  };
}

function baseAuditEvents(): AuditEvent[] {
  return [
    {
      id: "audit-2",
      at: new Date("2026-03-08T00:00:01.000Z").toISOString(),
      level: "error",
      category: "workspace",
      action: "workspace_cleanup_failed",
      issueId: "9",
      issueIdentifier: "ENG-9",
      message: "workspace remove failed"
    },
    {
      id: "audit-1",
      at: new Date("2026-03-08T00:00:00.000Z").toISOString(),
      level: "info",
      category: "codex",
      action: "turn_completed",
      issueId: "9",
      issueIdentifier: "ENG-9",
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "Validation passed"
    }
  ];
}

function createStreamCollector(stream: Readable): {
  waitFor: (needle: string, timeoutMs?: number) => Promise<string>;
} {
  let buffer = "";
  const waiters = new Set<{
    needle: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  const flushWaiters = (): void => {
    for (const waiter of [...waiters]) {
      if (!buffer.includes(waiter.needle)) {
        continue;
      }

      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(buffer);
    }
  };

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    flushWaiters();
  });
  stream.on("error", (error: Error) => {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(error);
    }
  });
  stream.on("end", () => {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(`SSE stream ended before receiving ${waiter.needle}`));
    }
  });

  return {
    waitFor(needle: string, timeoutMs = 2_000): Promise<string> {
      if (buffer.includes(needle)) {
        return Promise.resolve(buffer);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for SSE data after ${timeoutMs}ms`));
        }, timeoutMs);

        const waiter = {
          needle,
          resolve,
          reject,
          timer
        };

        waiters.add(waiter);
      });
    }
  };
}
