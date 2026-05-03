import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { JsonlAuditStore } from "../src/audit.js";
import { createLogger } from "../src/logging.js";
import type { AuditConfig } from "../src/types.js";

describe("JsonlAuditStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("appends audit events to jsonl and reloads recent events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-audit-"));
    tempDirs.push(root);
    const config = auditConfig(root);
    const store = new JsonlAuditStore(config, createLogger({ enabled: false }));

    await store.initialize();
    await store.record({
      level: "info",
      category: "scheduler",
      action: "dispatch_started",
      issueId: "1",
      issueIdentifier: "ENG-1",
      message: "Started"
    });
    await store.flush();

    const filePath = path.join(root, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("dispatch_started");

    const reloaded = new JsonlAuditStore(config, createLogger({ enabled: false }));
    await reloaded.initialize();
    const page = reloaded.query({ issueIdentifier: "ENG-1" });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.action).toBe("dispatch_started");
  });

  test("caps the recent ring buffer and filters by level, category, and text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-audit-"));
    tempDirs.push(root);
    const store = new JsonlAuditStore(
      auditConfig(root, {
        maxRecentEvents: 2
      }),
      createLogger({ enabled: false })
    );

    await store.initialize();
    await store.record({ level: "info", category: "scheduler", action: "dispatch_started", message: "First" });
    await store.record({ level: "warn", category: "tool", action: "unsupported_tool_call", message: "Second" });
    await store.record({ level: "error", category: "workspace", action: "workspace_cleanup_failed", message: "Third" });

    expect(store.query().events.map((event) => event.action)).toEqual([
      "workspace_cleanup_failed",
      "unsupported_tool_call"
    ]);
    expect(store.query({ level: "error" }).events).toHaveLength(1);
    expect(store.query({ category: "tool", q: "unsupported" }).events[0]?.action).toBe("unsupported_tool_call");
  });

  test("bounds oversized event payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-audit-"));
    tempDirs.push(root);
    const store = new JsonlAuditStore(
      auditConfig(root, {
        maxEventBytes: 300
      }),
      createLogger({ enabled: false })
    );

    await store.initialize();
    await store.record({
      level: "info",
      category: "codex",
      action: "turn_completed",
      message: "x".repeat(500),
      data: {
        raw: "y".repeat(2_000)
      }
    });

    const event = store.query().events[0];
    expect(event?.data).toMatchObject({ truncated: true });
    expect(JSON.stringify(event).length).toBeLessThan(700);
  });

  test("counts failed recent only for failed dispatch completions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-audit-"));
    tempDirs.push(root);
    const store = new JsonlAuditStore(auditConfig(root), createLogger({ enabled: false }));

    await store.initialize();
    await store.record({
      level: "error",
      category: "workspace",
      action: "workspace_cleanup_failed",
      message: "cleanup failed"
    });
    await store.record({
      level: "info",
      category: "scheduler",
      action: "dispatch_finished",
      message: "inactive state Human Review",
      data: {
        status: "failed",
        cancellationKind: "inactive"
      }
    });
    await store.record({
      level: "error",
      category: "scheduler",
      action: "dispatch_finished",
      message: "attempt failed",
      data: {
        status: "failed"
      }
    });

    expect(store.getSummary()).toMatchObject({
      errorCount: 2,
      failedRecentCount: 1
    });
  });

  test("ignores malformed jsonl lines and removes retained-out files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-audit-"));
    tempDirs.push(root);
    await writeFile(path.join(root, "2000-01-01.jsonl"), "{bad json\n", "utf8");
    await writeFile(
      path.join(root, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      '{"id":"audit-1","at":"2026-01-01T00:00:00.000Z","level":"info","category":"scheduler","action":"loaded"}\nnot json\n',
      "utf8"
    );

    const store = new JsonlAuditStore(
      auditConfig(root, {
        retentionDays: 1
      }),
      createLogger({ enabled: false })
    );

    await store.initialize();

    expect(store.query().events.map((event) => event.action)).toEqual(["loaded"]);
    expect(await readdir(root)).not.toContain("2000-01-01.jsonl");
  });
});

function auditConfig(outputDir: string, overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    enabled: true,
    outputDir,
    maxRecentEvents: 500,
    maxEventBytes: 16_384,
    retentionDays: 14,
    includeRawCodexEvents: false,
    ...overrides
  };
}
