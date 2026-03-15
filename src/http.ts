import Fastify from "fastify";
import type { Logger } from "pino";

import type { IssueRuntimeSnapshot, RuntimeSnapshot } from "./types.js";

const SSE_HEARTBEAT_MS = 15_000;

export interface HttpRuntimeSource {
  getRuntimeSnapshot(): RuntimeSnapshot;
  getIssueSnapshot(issueIdentifier: string): IssueRuntimeSnapshot | null;
  requestRefresh(): Promise<{ queued: boolean; coalesced: boolean }>;
  subscribeRuntimeSnapshots(listener: (snapshot: RuntimeSnapshot) => void): () => void;
}

export function createHttpServer(orchestrator: HttpRuntimeSource, logger: Logger): ReturnType<typeof Fastify> {
  const app = Fastify({
    loggerInstance: logger.child({ component: "http_server" })
  });

  app.get("/", async (_request, reply) => {
    const snapshot = orchestrator.getRuntimeSnapshot();
    reply.type("text/html; charset=utf-8");
    return renderDashboard(snapshot);
  });

  app.get("/favicon.ico", async (_request, reply) => {
    reply.code(204);
    reply.type("image/x-icon");
    return "";
  });

  app.get("/api/v1/state", async () => orchestrator.getRuntimeSnapshot());

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
    let unsubscribe: () => void = () => {};

    const cleanup = (): void => {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
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

    unsubscribe = orchestrator.subscribeRuntimeSnapshots(writeSnapshot);
    response.write("retry: 2000\n\n");
    writeSnapshot(orchestrator.getRuntimeSnapshot());

    request.raw.once("close", cleanup);
    response.once("close", cleanup);
    response.once("error", cleanup);
  });

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

function renderDashboard(snapshot: RuntimeSnapshot): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Runtime</title>
    <style>
      :root {
        --bg: #f4efe7;
        --surface: #fffaf3;
        --ink: #1b1a18;
        --muted: #6d6559;
        --accent: #1f6f5f;
        --accent-2: #d67c3c;
        --line: #e3d7c7;
      }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        background:
          radial-gradient(circle at top left, rgba(214, 124, 60, 0.18), transparent 28%),
          radial-gradient(circle at bottom right, rgba(31, 111, 95, 0.18), transparent 28%),
          var(--bg);
        color: var(--ink);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1, h2 {
        margin: 0 0 12px;
      }
      .hero {
        display: grid;
        gap: 16px;
        margin-bottom: 24px;
        padding: 24px;
        background: linear-gradient(135deg, rgba(255,255,255,0.88), rgba(255,250,243,0.96));
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 18px 50px rgba(27, 26, 24, 0.08);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px 16px;
      }
      .live-status {
        margin: 8px 0 0;
        color: var(--muted);
      }
      body[data-live-state="connected"] .live-status {
        color: var(--accent);
      }
      body[data-live-state="disconnected"] .live-status {
        color: var(--accent-2);
      }
      .label {
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        font-size: 1.65rem;
        font-weight: 700;
        margin-top: 6px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: rgba(255, 250, 243, 0.95);
        border: 1px solid var(--line);
        border-radius: 16px;
        overflow: hidden;
      }
      th, td {
        text-align: left;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      th {
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      section {
        margin-top: 28px;
      }
      code {
        font-family: "SF Mono", "Menlo", monospace;
        font-size: 0.9em;
      }
    </style>
  </head>
  <body data-live-state="connecting">
    <main>
      <section class="hero">
        <div>
          <h1>Symphony Runtime</h1>
          <p>Workflow: <code id="workflow-path">${escapeHtml(snapshot.workflow.path)}</code></p>
          <p class="live-status" id="live-status">Live updates connecting...</p>
        </div>
        <div class="stats">
          <div class="card">
            <div class="label">Running</div>
            <div class="value" id="running-count">${snapshot.counts.running}</div>
          </div>
          <div class="card">
            <div class="label">Retrying</div>
            <div class="value" id="retrying-count">${snapshot.counts.retrying}</div>
          </div>
          <div class="card">
            <div class="label">Total Tokens</div>
            <div class="value" id="total-tokens-count">${snapshot.codexTotals.totalTokens}</div>
          </div>
          <div class="card">
            <div class="label">Runtime Seconds</div>
            <div class="value" id="runtime-seconds-count">${formatRuntimeSeconds(snapshot.codexTotals.secondsRunning)}</div>
          </div>
        </div>
      </section>
      <section>
        <h2>Active Runs</h2>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>State</th>
              <th>Session</th>
              <th>Turns</th>
              <th>Last Event</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="running-body">${renderRunningRows(snapshot)}</tbody>
        </table>
      </section>
      <section>
        <h2>Retry Queue</h2>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Due At</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody id="retry-body">${renderRetryRows(snapshot)}</tbody>
        </table>
      </section>
    </main>
    <script>
      (function () {
        if (!window.EventSource) {
          var unsupportedStatus = document.getElementById("live-status");
          if (unsupportedStatus) {
            unsupportedStatus.textContent = "Live updates unavailable in this browser.";
          }
          document.body.dataset.liveState = "disconnected";
          return;
        }

        var workflowPath = document.getElementById("workflow-path");
        var liveStatus = document.getElementById("live-status");
        var runningCount = document.getElementById("running-count");
        var retryingCount = document.getElementById("retrying-count");
        var totalTokensCount = document.getElementById("total-tokens-count");
        var runtimeSecondsCount = document.getElementById("runtime-seconds-count");
        var runningBody = document.getElementById("running-body");
        var retryBody = document.getElementById("retry-body");

        function escapeHtml(value) {
          return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        }

        function formatRuntimeSeconds(value) {
          var numeric = Number(value);
          return Number.isFinite(numeric) ? numeric.toFixed(1) : "0.0";
        }

        function renderRunningRows(rows) {
          if (!Array.isArray(rows) || rows.length === 0) {
            return '<tr><td colspan="6">No active runs</td></tr>';
          }

          return rows
            .map(function (row) {
              return '<tr>' +
                '<td>' + escapeHtml(row.issueIdentifier) + '</td>' +
                '<td>' + escapeHtml(row.state) + '</td>' +
                '<td>' + escapeHtml(row.sessionId || '-') + '</td>' +
                '<td>' + String(row.turnCount) + '</td>' +
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
                '<td>' + escapeHtml(row.dueAt) + '</td>' +
                '<td>' + escapeHtml(row.error || '-') + '</td>' +
              '</tr>';
            })
            .join('');
        }

        function applySnapshot(snapshot) {
          if (!snapshot || typeof snapshot !== "object") {
            return;
          }

          if (workflowPath) {
            workflowPath.textContent = snapshot.workflow && snapshot.workflow.path ? snapshot.workflow.path : "-";
          }
          if (runningCount) {
            runningCount.textContent = String(snapshot.counts && typeof snapshot.counts.running === "number" ? snapshot.counts.running : 0);
          }
          if (retryingCount) {
            retryingCount.textContent = String(snapshot.counts && typeof snapshot.counts.retrying === "number" ? snapshot.counts.retrying : 0);
          }
          if (totalTokensCount) {
            totalTokensCount.textContent = String(snapshot.codexTotals && typeof snapshot.codexTotals.totalTokens === "number" ? snapshot.codexTotals.totalTokens : 0);
          }
          if (runtimeSecondsCount) {
            runtimeSecondsCount.textContent = formatRuntimeSeconds(snapshot.codexTotals && snapshot.codexTotals.secondsRunning);
          }
          if (runningBody) {
            runningBody.innerHTML = renderRunningRows(snapshot.running);
          }
          if (retryBody) {
            retryBody.innerHTML = renderRetryRows(snapshot.retrying);
          }
        }

        var source = new EventSource('/api/v1/events');
        source.onopen = function () {
          document.body.dataset.liveState = "connected";
          if (liveStatus) {
            liveStatus.textContent = "Live updates connected.";
          }
        };
        source.onerror = function () {
          document.body.dataset.liveState = "disconnected";
          if (liveStatus) {
            liveStatus.textContent = "Live updates reconnecting...";
          }
        };
        source.addEventListener('snapshot', function (event) {
          try {
            applySnapshot(JSON.parse(event.data));
            document.body.dataset.liveState = "connected";
            if (liveStatus) {
              liveStatus.textContent = "Live updates connected.";
            }
          } catch (_error) {
            document.body.dataset.liveState = "disconnected";
            if (liveStatus) {
              liveStatus.textContent = "Live updates waiting for valid data...";
            }
          }
        });
      })();
    </script>
  </body>
</html>`;
}

function renderRunningRows(snapshot: RuntimeSnapshot): string {
  if (snapshot.running.length === 0) {
    return `<tr><td colspan="6">No active runs</td></tr>`;
  }

  return snapshot.running
    .map(
      (row) => `<tr>
<td>${escapeHtml(row.issueIdentifier)}</td>
<td>${escapeHtml(row.state)}</td>
<td>${escapeHtml(row.sessionId ?? "-")}</td>
<td>${row.turnCount}</td>
<td>${escapeHtml(row.lastEvent ?? "-")}</td>
<td>${escapeHtml(row.lastMessage ?? "-")}</td>
</tr>`
    )
    .join("");
}

function renderRetryRows(snapshot: RuntimeSnapshot): string {
  if (snapshot.retrying.length === 0) {
    return `<tr><td colspan="4">No queued retries</td></tr>`;
  }

  return snapshot.retrying
    .map(
      (row) => `<tr>
<td>${escapeHtml(row.issueIdentifier)}</td>
<td>${row.attempt}</td>
<td>${escapeHtml(row.dueAt)}</td>
<td>${escapeHtml(row.error ?? "-")}</td>
</tr>`
    )
    .join("");
}

function formatRuntimeSeconds(value: number): string {
  return value.toFixed(1);
}

function formatSseEvent(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
