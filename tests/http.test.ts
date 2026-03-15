import type { Readable } from "node:stream";
import vm from "node:vm";

import { afterEach, describe, expect, test } from "vitest";

import { createHttpServer } from "../src/http.js";
import { createLogger } from "../src/logging.js";
import type { RuntimeSnapshot } from "../src/types.js";

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
});

function createFakeOrchestrator(initialSnapshot: RuntimeSnapshot = baseSnapshot()) {
  let snapshot = initialSnapshot;
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();

  return {
    getRuntimeSnapshot() {
      return snapshot;
    },
    getIssueSnapshot() {
      return null;
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
    emitRuntimeSnapshot(nextSnapshot: RuntimeSnapshot) {
      snapshot = nextSnapshot;
      for (const listener of [...listeners]) {
        listener(snapshot);
      }
    }
  };
}

function baseSnapshot(): RuntimeSnapshot {
  return {
    generatedAt: new Date("2026-03-08T00:00:00.000Z").toISOString(),
    counts: {
      running: 0,
      retrying: 0
    },
    running: [],
    retrying: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0
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
      retrying: 0
    },
    running: [
      {
        issueId: "9",
        issueIdentifier: "ENG-9",
        state: "In Progress",
        sessionId: "thread-1-turn-1",
        turnCount: 2,
        lastEvent: "turn_completed",
        lastMessage: "Validation passed",
        startedAt: new Date("2026-03-08T00:00:00.000Z").toISOString(),
        lastEventAt: new Date("2026-03-08T00:00:01.000Z").toISOString(),
        tokens: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20
        }
      }
    ]
  };
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
