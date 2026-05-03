import Fastify from "fastify";
import type { Logger } from "pino";

import type {
  AuditCategory,
  AuditEvent,
  AuditEventPage,
  AuditEventQuery,
  AuditLevel,
  IssueRuntimeSnapshot,
  RuntimeSnapshot
} from "./types.js";

const SSE_HEARTBEAT_MS = 15_000;
const AUDIT_CATEGORIES: AuditCategory[] = [
  "scheduler",
  "agent",
  "codex",
  "tool",
  "workspace",
  "tracker",
  "config",
  "http"
];
const AUDIT_LEVELS: AuditLevel[] = ["debug", "info", "warn", "error"];

interface AuditQueryParams {
  limit?: string | number;
  issue_identifier?: string;
  category?: string;
  level?: string;
  q?: string;
}

export interface HttpRuntimeSource {
  getRuntimeSnapshot(): RuntimeSnapshot;
  getIssueSnapshot(issueIdentifier: string): IssueRuntimeSnapshot | null;
  getAuditEvents(query?: AuditEventQuery): AuditEventPage;
  requestRefresh(): Promise<{ queued: boolean; coalesced: boolean }>;
  subscribeRuntimeSnapshots(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  subscribeAuditEvents(listener: (event: AuditEvent) => void): () => void;
}

export function createHttpServer(orchestrator: HttpRuntimeSource, logger: Logger): ReturnType<typeof Fastify> {
  const app = Fastify({
    loggerInstance: logger.child({ component: "http_server" })
  });

  app.get("/", async (_request, reply) => {
    const snapshot = orchestrator.getRuntimeSnapshot();
    const auditPage = orchestrator.getAuditEvents({ limit: 200 });
    reply.type("text/html; charset=utf-8");
    return renderDashboard(snapshot, auditPage);
  });

  app.get("/favicon.ico", async (_request, reply) => {
    reply.code(204);
    reply.type("image/x-icon");
    return "";
  });

  app.get("/api/v1/state", async () => orchestrator.getRuntimeSnapshot());

  app.get<{ Querystring: AuditQueryParams }>("/api/v1/audit", async (request) =>
    orchestrator.getAuditEvents(parseAuditQuery(request.query))
  );

  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack();

    const response = reply.raw;
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders?.();

    let closed = false;
    let unsubscribeSnapshot: () => void = () => {};
    let unsubscribeAudit: () => void = () => {};

    const cleanup = (): void => {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(heartbeat);
      unsubscribeSnapshot();
      unsubscribeAudit();
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    };

    const writeSnapshot = (snapshot: RuntimeSnapshot): void => {
      if (closed || response.writableEnded || response.destroyed) {
        cleanup();
        return;
      }

      try {
        response.write(formatSseEvent("snapshot", snapshot));
      } catch {
        cleanup();
      }
    };

    const writeAuditEvent = (event: AuditEvent): void => {
      if (closed || response.writableEnded || response.destroyed) {
        cleanup();
        return;
      }

      try {
        response.write(formatSseEvent("audit", event));
      } catch {
        cleanup();
      }
    };

    const heartbeat = setInterval(() => {
      if (closed || response.writableEnded || response.destroyed) {
        cleanup();
        return;
      }

      try {
        response.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    unsubscribeSnapshot = orchestrator.subscribeRuntimeSnapshots(writeSnapshot);
    unsubscribeAudit = orchestrator.subscribeAuditEvents(writeAuditEvent);
    response.write("retry: 2000\n\n");
    writeSnapshot(orchestrator.getRuntimeSnapshot());

    request.raw.once("close", cleanup);
    response.once("close", cleanup);
    response.once("error", cleanup);
  });

  app.get<{ Params: { issue_identifier: string }; Querystring: AuditQueryParams }>(
    "/api/v1/:issue_identifier/audit",
    async (request) =>
      orchestrator.getAuditEvents({
        ...parseAuditQuery(request.query),
        issueIdentifier: request.params.issue_identifier
      })
  );

  app.get<{ Params: { issue_identifier: string } }>("/api/v1/:issue_identifier", async (request, reply) => {
    const snapshot = orchestrator.getIssueSnapshot(request.params.issue_identifier);
    if (!snapshot) {
      reply.code(404);
      return {
        error: {
          code: "issue_not_found",
          message: `Unknown issue identifier ${request.params.issue_identifier}`
        }
      };
    }

    return snapshot;
  });

  app.post("/api/v1/refresh", async (_request, reply) => {
    const refresh = await orchestrator.requestRefresh();
    reply.code(202);
    return {
      queued: refresh.queued,
      coalesced: refresh.coalesced,
      requested_at: new Date().toISOString(),
      operations: ["poll", "reconcile"]
    };
  });

  return app;
}

export async function startHttpServer(
  orchestrator: HttpRuntimeSource,
  logger: Logger,
  port: number
): Promise<ReturnType<typeof Fastify>> {
  const app = createHttpServer(orchestrator, logger);

  await app.listen({
    host: "127.0.0.1",
    port
  });

  return app;
}

function parseAuditQuery(query: AuditQueryParams): AuditEventQuery {
  const category = typeof query.category === "string" && isAuditCategory(query.category) ? query.category : undefined;
  const level = typeof query.level === "string" && isAuditLevel(query.level) ? query.level : undefined;
  const limit =
    typeof query.limit === "number"
      ? query.limit
      : typeof query.limit === "string" && query.limit.trim() !== ""
        ? Number.parseInt(query.limit, 10)
        : undefined;

  const parsed: AuditEventQuery = {};
  if (typeof limit === "number" && Number.isFinite(limit)) {
    parsed.limit = limit;
  }
  if (typeof query.issue_identifier === "string" && query.issue_identifier.trim() !== "") {
    parsed.issueIdentifier = query.issue_identifier.trim();
  }
  if (category) {
    parsed.category = category;
  }
  if (level) {
    parsed.level = level;
  }
  if (typeof query.q === "string" && query.q.trim() !== "") {
    parsed.q = query.q.trim();
  }
  return parsed;
}

function isAuditCategory(value: string): value is AuditCategory {
  return AUDIT_CATEGORIES.includes(value as AuditCategory);
}

function isAuditLevel(value: string): value is AuditLevel {
  return AUDIT_LEVELS.includes(value as AuditLevel);
}

function renderDashboard(snapshot: RuntimeSnapshot, auditPage: AuditEventPage): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Runtime</title>
    <style>
      :root {
        --bg: #f6f7f9;
        --surface: #ffffff;
        --surface-2: #f9fafb;
        --ink: #111827;
        --muted: #667085;
        --line: #d9dee7;
        --line-soft: #edf0f4;
        --teal: #0f766e;
        --teal-soft: #e6f5f3;
        --blue: #2563eb;
        --blue-soft: #eaf1ff;
        --amber: #b45309;
        --amber-soft: #fff5df;
        --red: #b42318;
        --red-soft: #fff0ee;
        --shadow: 0 12px 28px rgba(16, 24, 40, 0.07);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--ink);
      }
      button, input {
        font: inherit;
      }
      main {
        max-width: 1480px;
        margin: 0 auto;
        padding: 18px 20px 28px;
      }
      h1, h2, h3, p {
        margin: 0 0 12px;
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 3;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px;
        align-items: center;
        padding: 14px 16px;
        margin-bottom: 14px;
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }
      .title-row {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }
      h1 {
        font-size: 1.05rem;
        line-height: 1.2;
      }
      .workflow {
        display: block;
        color: var(--muted);
        font-family: "SF Mono", "Menlo", monospace;
        font-size: 0.78rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--muted);
        font-size: 0.78rem;
        white-space: nowrap;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--muted);
      }
      body[data-live-state="connected"] .live-dot {
        background: var(--teal);
      }
      body[data-live-state="disconnected"] .live-dot {
        background: var(--amber);
      }
      .button {
        min-height: 32px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        color: var(--ink);
        padding: 6px 10px;
        cursor: pointer;
      }
      .button:hover {
        border-color: #b7c0ce;
      }
      .button.primary {
        background: var(--ink);
        border-color: var(--ink);
        color: #fff;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
      }
      .label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.76rem;
        color: var(--muted);
        line-height: 1.2;
      }
      .value {
        font-size: 1.45rem;
        font-weight: 720;
        margin-top: 6px;
        line-height: 1;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(360px, 0.75fr);
        gap: 14px;
        align-items: start;
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 8px;
        overflow: hidden;
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line-soft);
      }
      .panel-title {
        font-size: 0.88rem;
        font-weight: 700;
        margin: 0;
      }
      .panel-subtitle {
        color: var(--muted);
        font-size: 0.78rem;
        margin: 2px 0 0;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line-soft);
        vertical-align: middle;
        font-size: 0.84rem;
      }
      th {
        background: var(--surface-2);
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--muted);
        text-transform: uppercase;
      }
      .audit-item {
        cursor: pointer;
      }
      .audit-item:hover {
        background: #fbfcfe;
      }
      .status {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 0.76rem;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--muted);
        white-space: nowrap;
      }
      .status.in-progress, .status.running {
        color: var(--teal);
        background: var(--teal-soft);
        border-color: #b7dfd8;
      }
      .status.rework, .status.retrying {
        color: var(--amber);
        background: var(--amber-soft);
        border-color: #f6d58f;
      }
      .status.blocked, .status.error, .status.failed {
        color: var(--red);
        background: var(--red-soft);
        border-color: #f4b8b0;
      }
      .status.human-review, .status.merging {
        color: var(--blue);
        background: var(--blue-soft);
        border-color: #c7d8ff;
      }
      .mono {
        font-family: "SF Mono", "Menlo", monospace;
      }
      .muted {
        color: var(--muted);
      }
      .audit-tools {
        display: grid;
        gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line-soft);
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .filter {
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--muted);
        border-radius: 999px;
        min-height: 28px;
        padding: 4px 10px;
        cursor: pointer;
        font-size: 0.78rem;
      }
      .filter[aria-pressed="true"] {
        color: var(--ink);
        background: var(--surface-2);
        border-color: #aeb8c7;
      }
      .search-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }
      .search {
        width: 100%;
        min-height: 32px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 6px 9px;
        background: var(--surface);
      }
      .audit-list {
        max-height: 560px;
        overflow: auto;
      }
      .audit-viewport {
        position: relative;
        min-height: 320px;
      }
      .audit-detail-view {
        display: none;
        padding: 12px 14px;
        background: var(--surface);
      }
      .audit-viewport[data-view="detail"] .audit-list {
        display: none;
      }
      .audit-viewport[data-view="detail"] .audit-detail-view {
        display: grid;
        gap: 12px;
      }
      .audit-detail-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--line-soft);
      }
      .audit-detail-heading {
        min-width: 0;
      }
      .audit-detail-title {
        margin: 0;
        font-size: 0.92rem;
        font-weight: 740;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .audit-detail-subtitle {
        margin: 3px 0 0;
        color: var(--muted);
        font-size: 0.78rem;
      }
      .audit-item {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 10px;
        padding: 11px 14px;
        border-bottom: 1px solid var(--line-soft);
      }
      .severity-dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        margin-top: 5px;
        background: var(--blue);
      }
      .severity-dot.warn {
        background: var(--amber);
      }
      .severity-dot.error {
        background: var(--red);
      }
      .audit-main {
        min-width: 0;
      }
      .audit-line {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        font-size: 0.84rem;
      }
      .audit-action {
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .audit-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 4px;
        color: var(--muted);
        font-size: 0.76rem;
      }
      .detail {
        position: sticky;
        top: 86px;
      }
      .detail-body {
        padding: 12px 14px;
        display: grid;
        gap: 10px;
        font-size: 0.84rem;
      }
      .kv {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: 8px;
      }
      .pre {
        max-height: 240px;
        overflow: auto;
        padding: 10px;
        background: #101828;
        color: #f2f4f7;
        border-radius: 8px;
        font-size: 0.76rem;
        white-space: pre-wrap;
      }
      .split {
        display: grid;
        gap: 14px;
      }
      .bar {
        height: 8px;
        background: var(--line-soft);
        border-radius: 999px;
        overflow: hidden;
        margin-top: 6px;
      }
      .bar > span {
        display: block;
        height: 100%;
        width: 42%;
        background: var(--teal);
      }
      section {
        min-width: 0;
      }
      code {
        font-family: "SF Mono", "Menlo", monospace;
        font-size: 0.9em;
      }
      @media (max-width: 1120px) {
        .stats, .layout, .split {
          grid-template-columns: 1fr 1fr;
        }
        .layout {
          grid-template-columns: 1fr;
        }
        .detail {
          position: static;
        }
      }
      @media (max-width: 760px) {
        main {
          padding: 12px;
        }
        .topbar, .stats, .split, .search-row {
          grid-template-columns: 1fr;
        }
        .actions {
          justify-content: flex-start;
          flex-wrap: wrap;
        }
        th:nth-child(4), td:nth-child(4),
        th:nth-child(6), td:nth-child(6),
        th:nth-child(8), td:nth-child(8) {
          display: none;
        }
      }
    </style>
  </head>
  <body data-live-state="connecting">
    <main>
      <header class="topbar">
        <div>
          <div class="title-row">
            <h1>Symphony Runtime</h1>
            <span class="pill" id="live-status"><span class="dot live-dot"></span>Connecting</span>
          </div>
          <span class="workflow" id="workflow-path">-</span>
        </div>
        <div class="actions">
          <span class="pill">Updated <span id="last-updated">-</span></span>
          <button class="button primary" id="refresh-button" type="button">Refresh</button>
        </div>
      </header>

      <section class="stats" aria-label="Runtime metrics">
        <div class="card"><div class="label">Running <span class="dot" style="background: var(--teal)"></span></div><div class="value" id="running-count">0</div></div>
        <div class="card"><div class="label">Retrying <span class="dot" style="background: var(--amber)"></span></div><div class="value" id="retrying-count">0</div></div>
        <div class="card"><div class="label">Blocked <span class="dot" style="background: var(--red)"></span></div><div class="value" id="blocked-count">0</div></div>
        <div class="card"><div class="label">Failed Recent <span class="dot" style="background: var(--red)"></span></div><div class="value" id="failed-recent-count">0</div></div>
        <div class="card"><div class="label">Total Tokens <span class="dot" style="background: var(--blue)"></span></div><div class="value" id="total-tokens-count">0</div></div>
        <div class="card"><div class="label">Runtime <span class="dot" style="background: var(--teal)"></span></div><div class="value" id="runtime-count">0s</div></div>
      </section>

      <section class="layout">
        <div class="stack">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Active Agents</h2>
                <p class="panel-subtitle">Live session, token, and turn state</p>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>State</th>
                  <th>Attempt</th>
                  <th>Elapsed</th>
                  <th>Turns</th>
                  <th>Tokens</th>
                  <th>Last Event</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody id="running-body"><tr><td colspan="8">Loading runtime snapshot...</td></tr></tbody>
            </table>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Retry Queue</h2>
                <p class="panel-subtitle">Scheduled continuations and backoffs</p>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Attempt</th>
                  <th>Due</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody id="retry-body"><tr><td colspan="4">Loading runtime snapshot...</td></tr></tbody>
            </table>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Rate Limits</h2>
                <p class="panel-subtitle">Latest Codex telemetry</p>
              </div>
            </div>
            <div class="detail-body" id="rate-limit-body">
              <div class="muted">No rate-limit data yet.</div>
            </div>
          </section>
        </div>

        <div class="stack">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Audit Timeline</h2>
                <p class="panel-subtitle"><span id="audit-count">0</span> recent persisted events</p>
              </div>
            </div>
            <div class="audit-tools">
              <div class="filters" id="audit-filters">
                <button class="filter" type="button" data-filter="all" aria-pressed="true">All</button>
                <button class="filter" type="button" data-filter="error" aria-pressed="false">Errors</button>
                <button class="filter" type="button" data-filter="tool" aria-pressed="false">Tools</button>
                <button class="filter" type="button" data-filter="codex" aria-pressed="false">Codex</button>
                <button class="filter" type="button" data-filter="workspace" aria-pressed="false">Workspace</button>
              </div>
              <div class="search-row">
                <input class="search" id="audit-search" type="search" placeholder="Search issue, action, message, or ID" />
                <button class="button" id="pause-audit-button" type="button">Pause</button>
              </div>
            </div>
            <div class="audit-viewport" id="audit-viewport" data-view="list">
              <div class="audit-list" id="audit-list">Loading audit events...</div>
              <div class="audit-detail-view" id="audit-detail-view" aria-live="polite">
                <div class="audit-detail-toolbar">
                  <div class="audit-detail-heading">
                    <h3 class="audit-detail-title" id="audit-detail-title">Audit event</h3>
                    <p class="audit-detail-subtitle" id="audit-detail-subtitle">Event details</p>
                  </div>
                  <button class="button" id="audit-detail-back" type="button">Back</button>
                </div>
                <div class="detail-body" id="audit-detail-body">
                  <div class="muted">Select an audit event to inspect it.</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
    <script id="initial-snapshot" type="application/json">${serializeJsonForHtml(snapshot)}</script>
    <script id="initial-audit" type="application/json">${serializeJsonForHtml(auditPage)}</script>
    <script>
      (function () {
        var workflowPath = document.getElementById("workflow-path");
        var liveStatus = document.getElementById("live-status");
        var lastUpdated = document.getElementById("last-updated");
        var refreshButton = document.getElementById("refresh-button");
        var runningCount = document.getElementById("running-count");
        var retryingCount = document.getElementById("retrying-count");
        var blockedCount = document.getElementById("blocked-count");
        var failedRecentCount = document.getElementById("failed-recent-count");
        var totalTokensCount = document.getElementById("total-tokens-count");
        var runtimeCount = document.getElementById("runtime-count");
        var runningBody = document.getElementById("running-body");
        var retryBody = document.getElementById("retry-body");
        var rateLimitBody = document.getElementById("rate-limit-body");
        var auditViewport = document.getElementById("audit-viewport");
        var auditList = document.getElementById("audit-list");
        var auditDetailTitle = document.getElementById("audit-detail-title");
        var auditDetailSubtitle = document.getElementById("audit-detail-subtitle");
        var auditDetailBody = document.getElementById("audit-detail-body");
        var auditDetailBack = document.getElementById("audit-detail-back");
        var auditCount = document.getElementById("audit-count");
        var auditSearch = document.getElementById("audit-search");
        var pauseAuditButton = document.getElementById("pause-audit-button");
        var initialSnapshotElement = document.getElementById("initial-snapshot");
        var initialAuditElement = document.getElementById("initial-audit");
        var latestSnapshot = null;
        var auditEvents = [];
        var auditFilter = "all";
        var auditPaused = false;
        var pendingAuditEvents = 0;

        function escapeHtml(value) {
          return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        }

        function formatNumber(value) {
          var numeric = Number(value);
          return Number.isFinite(numeric) ? numeric.toLocaleString() : "0";
        }

        function formatDuration(seconds) {
          var value = Math.max(0, Number(seconds) || 0);
          var hours = Math.floor(value / 3600);
          var minutes = Math.floor((value % 3600) / 60);
          if (hours > 0) {
            return String(hours) + "h " + String(minutes) + "m";
          }
          if (minutes > 0) {
            return String(minutes) + "m";
          }
          return String(Math.floor(value)) + "s";
        }

        function formatTimestamp(value) {
          if (!value) {
            return "-";
          }
          var date = new Date(value);
          return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : String(value);
        }

        function elapsedSince(value) {
          if (!value) {
            return "-";
          }
          var parsed = Date.parse(value);
          if (!Number.isFinite(parsed)) {
            return "-";
          }
          return formatDuration((Date.now() - parsed) / 1000);
        }

        function statusClass(value) {
          return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
        }

        function renderRunningRows(rows) {
          if (!Array.isArray(rows) || rows.length === 0) {
            return '<tr><td colspan="8">No active runs</td></tr>';
          }

          return rows
            .map(function (row) {
              return '<tr data-issue-id="' + escapeHtml(row.issueId) + '">' +
                '<td>' + escapeHtml(row.issueIdentifier) + '</td>' +
                '<td><span class="status ' + escapeHtml(statusClass(row.state)) + '">' + escapeHtml(row.state) + '</span></td>' +
                '<td>' + (row.attempt === null || row.attempt === undefined ? "Fresh" : "#" + String(row.attempt)) + '</td>' +
                '<td>' + escapeHtml(elapsedSince(row.startedAt)) + '</td>' +
                '<td>' + String(row.turnCount) + '</td>' +
                '<td>' + escapeHtml(formatNumber(row.tokens && row.tokens.totalTokens)) + '</td>' +
                '<td>' + escapeHtml(row.lastEvent || '-') + '</td>' +
                '<td>' + escapeHtml(row.lastMessage || '-') + '</td>' +
              '</tr>';
            })
            .join('');
        }

        function renderRetryRows(rows) {
          if (!Array.isArray(rows) || rows.length === 0) {
            return '<tr><td colspan="4">No queued retries</td></tr>';
          }

          return rows
            .map(function (row) {
              return '<tr>' +
                '<td>' + escapeHtml(row.issueIdentifier) + '</td>' +
                '<td>' + String(row.attempt) + '</td>' +
                '<td>' + escapeHtml(formatTimestamp(row.dueAt)) + '</td>' +
                '<td>' + escapeHtml(row.error || '-') + '</td>' +
              '</tr>';
            })
            .join('');
        }

        function renderRateLimits(value) {
          if (!value || typeof value !== "object") {
            return '<div class="muted">No rate-limit data yet.</div>';
          }
          var entries = flattenRateLimits(value, "", 0).slice(0, 10);
          if (entries.length === 0) {
            return '<div class="muted">Rate-limit telemetry received, but no scalar values were available.</div>';
          }
          return entries.map(function (entry) {
            return '<div class="kv"><div class="muted">' + escapeHtml(humanizeRateKey(entry.label)) + '</div><div>' + escapeHtml(formatRateValue(entry.value)) + '</div></div>';
          }).join('');
        }

        function flattenRateLimits(value, prefix, depth) {
          if (value === null || value === undefined || depth > 3) {
            return [];
          }
          if (typeof value !== "object") {
            return [{ label: prefix || "value", value: value }];
          }
          if (Array.isArray(value)) {
            var scalarItems = value.filter(function (item) {
              return item === null || typeof item !== "object";
            });
            return scalarItems.length > 0 ? [{ label: prefix || "items", value: scalarItems.join(", ") }] : [];
          }
          return Object.keys(value).flatMap(function (key) {
            var child = value[key];
            var label = prefix ? prefix + "." + key : key;
            return flattenRateLimits(child, label, depth + 1);
          });
        }

        function humanizeRateKey(value) {
          return String(value)
            .replace(/[_\\.]+/g, " ")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/\\s+/g, " ")
            .trim()
            .replace(/^./, function (letter) { return letter.toUpperCase(); });
        }

        function formatRateValue(value) {
          if (typeof value === "number") {
            return value.toLocaleString();
          }
          if (typeof value === "boolean") {
            return value ? "Yes" : "No";
          }
          if (typeof value === "string") {
            var parsed = Date.parse(value);
            if (Number.isFinite(parsed) && /\\d{4}-\\d{2}-\\d{2}|T\\d{2}:\\d{2}/.test(value)) {
              return new Date(parsed).toLocaleString();
            }
            return value;
          }
          return value === null || value === undefined ? "-" : String(value);
        }

        function filteredAuditEvents() {
          var q = auditSearch && auditSearch.value ? auditSearch.value.trim().toLowerCase() : "";
          return auditEvents.filter(function (event) {
            if (auditFilter === "error" && event.level !== "error") {
              return false;
            }
            if (auditFilter !== "all" && auditFilter !== "error" && event.category !== auditFilter) {
              return false;
            }
            if (!q) {
              return true;
            }
            return [
              event.action,
              event.category,
              event.level,
              event.issueIdentifier,
              event.message,
              event.sessionId,
              event.threadId,
              event.turnId,
              event.workspacePath
            ].filter(Boolean).join(" ").toLowerCase().includes(q);
          });
        }

        function renderAuditTimeline() {
          if (!auditList) {
            return;
          }
          var rows = filteredAuditEvents();
          if (auditCount) {
            auditCount.textContent = String(rows.length);
          }
          if (rows.length === 0) {
            auditList.innerHTML = '<div class="audit-item"><div></div><div class="muted">No audit events match the current filters.</div></div>';
            return;
          }
          auditList.innerHTML = rows.slice(0, 250).map(function (event) {
            return '<div class="audit-item" data-event-id="' + escapeHtml(event.id) + '">' +
              '<span class="severity-dot ' + escapeHtml(event.level) + '"></span>' +
              '<div class="audit-main">' +
                '<div class="audit-line"><span class="status ' + escapeHtml(event.level) + '">' + escapeHtml(event.level) + '</span><span class="audit-action">' + escapeHtml(event.action) + '</span></div>' +
                '<div class="audit-meta"><span>' + escapeHtml(formatTimestamp(event.at)) + '</span><span>' + escapeHtml(event.category) + '</span><span>' + escapeHtml(event.issueIdentifier || '-') + '</span><span>' + escapeHtml(event.message || '') + '</span></div>' +
              '</div>' +
            '</div>';
          }).join('');
        }

        function applyAuditPage(page) {
          if (!page || !Array.isArray(page.events)) {
            return;
          }
          auditEvents = page.events.slice();
          renderAuditTimeline();
        }

        function addAuditEvent(event) {
          if (!event || typeof event !== "object" || !event.id) {
            return;
          }
          auditEvents = [event].concat(auditEvents.filter(function (existing) {
            return existing.id !== event.id;
          })).slice(0, 500);
          if (auditPaused) {
            pendingAuditEvents += 1;
            if (pauseAuditButton) {
              pauseAuditButton.textContent = "Resume (" + String(pendingAuditEvents) + ")";
            }
            return;
          }
          renderAuditTimeline();
        }

        function showAuditList() {
          if (auditViewport) {
            auditViewport.dataset.view = "list";
          }
        }

        function showAuditDetail(event) {
          if (!event || !auditDetailBody) {
            return;
          }
          if (auditDetailTitle) {
            auditDetailTitle.textContent = event.action || "Audit event";
          }
          if (auditDetailSubtitle) {
            auditDetailSubtitle.textContent = (event.category || "-") + " / " + (event.level || "-") + " / " + formatTimestamp(event.at);
          }
          auditDetailBody.innerHTML =
            '<div class="kv"><div class="muted">At</div><div>' + escapeHtml(event.at || '-') + '</div></div>' +
            '<div class="kv"><div class="muted">Issue</div><div>' + escapeHtml(event.issueIdentifier || '-') + '</div></div>' +
            '<div class="kv"><div class="muted">Session</div><div class="mono">' + escapeHtml(event.sessionId || '-') + '</div></div>' +
            '<div class="kv"><div class="muted">Thread</div><div class="mono">' + escapeHtml(event.threadId || '-') + '</div></div>' +
            '<div class="kv"><div class="muted">Turn</div><div class="mono">' + escapeHtml(event.turnId || '-') + '</div></div>' +
            '<div class="kv"><div class="muted">Workspace</div><div class="mono">' + escapeHtml(event.workspacePath || '-') + '</div></div>' +
            '<div class="kv"><div class="muted">Message</div><div>' + escapeHtml(event.message || '-') + '</div></div>' +
            '<pre class="pre">' + escapeHtml(JSON.stringify(event.data || {}, null, 2)) + '</pre>';
          if (auditViewport) {
            auditViewport.dataset.view = "detail";
          }
        }

        function applySnapshot(snapshot) {
          if (!snapshot || typeof snapshot !== "object") {
            return;
          }
          latestSnapshot = snapshot;

          if (workflowPath) {
            workflowPath.textContent = snapshot.workflow && snapshot.workflow.path ? snapshot.workflow.path : "-";
          }
          if (lastUpdated) {
            lastUpdated.textContent = formatTimestamp(snapshot.generatedAt);
          }
          if (runningCount) {
            runningCount.textContent = String(snapshot.counts && typeof snapshot.counts.running === "number" ? snapshot.counts.running : 0);
          }
          if (retryingCount) {
            retryingCount.textContent = String(snapshot.counts && typeof snapshot.counts.retrying === "number" ? snapshot.counts.retrying : 0);
          }
          if (blockedCount) {
            blockedCount.textContent = String(snapshot.counts && typeof snapshot.counts.blocked === "number" ? snapshot.counts.blocked : 0);
          }
          if (failedRecentCount) {
            failedRecentCount.textContent = String(snapshot.audit && typeof snapshot.audit.failedRecentCount === "number" ? snapshot.audit.failedRecentCount : 0);
          }
          if (totalTokensCount) {
            totalTokensCount.textContent = formatNumber(snapshot.codexTotals && snapshot.codexTotals.totalTokens);
          }
          if (runtimeCount) {
            runtimeCount.textContent = formatDuration(snapshot.codexTotals && snapshot.codexTotals.secondsRunning);
          }
          if (runningBody) {
            runningBody.innerHTML = renderRunningRows(snapshot.running);
          }
          if (retryBody) {
            retryBody.innerHTML = renderRetryRows(snapshot.retrying);
          }
          if (rateLimitBody) {
            rateLimitBody.innerHTML = renderRateLimits(snapshot.rateLimits);
          }
        }

        if (initialSnapshotElement && typeof initialSnapshotElement.textContent === "string") {
          try {
            applySnapshot(JSON.parse(initialSnapshotElement.textContent));
          } catch (_error) {
            if (liveStatus) {
              liveStatus.textContent = "Live updates waiting for valid data...";
            }
          }
        }
        if (initialAuditElement && typeof initialAuditElement.textContent === "string") {
          try {
            applyAuditPage(JSON.parse(initialAuditElement.textContent));
          } catch (_error) {
            if (auditList) {
              auditList.innerHTML = '<div class="audit-item"><div></div><div class="muted">Audit events waiting for valid data.</div></div>';
            }
          }
        }

        function on(element, eventName, handler) {
          if (element && typeof element.addEventListener === "function") {
            element.addEventListener(eventName, handler);
          }
        }

        on(refreshButton, "click", function () {
          if (!window.fetch) {
            return;
          }
          refreshButton.disabled = true;
          refreshButton.textContent = "Refreshing";
          fetch('/api/v1/refresh', { method: 'POST' })
            .finally(function () {
              refreshButton.disabled = false;
              refreshButton.textContent = "Refresh";
            });
        });

        on(auditList, "click", function (event) {
          var item = event.target && event.target.closest ? event.target.closest("[data-event-id]") : null;
          if (!item) {
            return;
          }
          var selected = auditEvents.find(function (eventItem) {
            return eventItem.id === item.getAttribute("data-event-id");
          });
          showAuditDetail(selected);
        });
        on(auditDetailBack, "click", showAuditList);

        if (document.querySelectorAll) {
          Array.prototype.slice.call(document.querySelectorAll("[data-filter]")).forEach(function (button) {
            on(button, "click", function () {
              auditFilter = button.getAttribute("data-filter") || "all";
              Array.prototype.slice.call(document.querySelectorAll("[data-filter]")).forEach(function (other) {
                other.setAttribute("aria-pressed", other === button ? "true" : "false");
              });
              showAuditList();
              renderAuditTimeline();
            });
          });
        }

        on(auditSearch, "input", function () {
          showAuditList();
          renderAuditTimeline();
        });
        on(pauseAuditButton, "click", function () {
          auditPaused = !auditPaused;
          if (!auditPaused) {
            pendingAuditEvents = 0;
            pauseAuditButton.textContent = "Pause";
            renderAuditTimeline();
          } else {
            pauseAuditButton.textContent = "Resume";
          }
        });

        if (!window.EventSource) {
          if (liveStatus) {
            liveStatus.innerHTML = '<span class="dot live-dot"></span>Live updates unavailable';
          }
          document.body.dataset.liveState = "disconnected";
          return;
        }

        var source = new EventSource('/api/v1/events');
        source.onopen = function () {
          document.body.dataset.liveState = "connected";
          if (liveStatus) {
            liveStatus.innerHTML = '<span class="dot live-dot"></span>Connected';
          }
        };
        source.onerror = function () {
          document.body.dataset.liveState = "disconnected";
          if (liveStatus) {
            liveStatus.innerHTML = '<span class="dot live-dot"></span>Reconnecting';
          }
        };
        source.addEventListener('snapshot', function (event) {
          try {
            applySnapshot(JSON.parse(event.data));
            document.body.dataset.liveState = "connected";
            if (liveStatus) {
              liveStatus.innerHTML = '<span class="dot live-dot"></span>Connected';
            }
          } catch (_error) {
            document.body.dataset.liveState = "disconnected";
            if (liveStatus) {
              liveStatus.innerHTML = '<span class="dot live-dot"></span>Waiting for data';
            }
          }
        });
        source.addEventListener('audit', function (event) {
          try {
            addAuditEvent(JSON.parse(event.data));
          } catch (_error) {
            return;
          }
        });
      })();
    </script>
  </body>
</html>`;
}

function formatSseEvent(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function serializeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}
