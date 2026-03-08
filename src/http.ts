import Fastify from "fastify";
import type { Logger } from "pino";

import { Orchestrator } from "./orchestrator.js";

export async function startHttpServer(
  orchestrator: Orchestrator,
  logger: Logger,
  port: number
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    loggerInstance: logger.child({ component: "http_server" })
  });

  app.get("/", async () => {
    const snapshot = orchestrator.getRuntimeSnapshot();
    return renderDashboard(snapshot);
  });

  app.get("/api/v1/state", async () => orchestrator.getRuntimeSnapshot());

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

  await app.listen({
    host: "127.0.0.1",
    port
  });

  return app;
}

function renderDashboard(snapshot: ReturnType<Orchestrator["getRuntimeSnapshot"]>): string {
  const runningRows =
    snapshot.running.length === 0
      ? `<tr><td colspan="6">No active runs</td></tr>`
      : snapshot.running
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

  const retryRows =
    snapshot.retrying.length === 0
      ? `<tr><td colspan="4">No queued retries</td></tr>`
      : snapshot.retrying
          .map(
            (row) => `<tr>
<td>${escapeHtml(row.issueIdentifier)}</td>
<td>${row.attempt}</td>
<td>${escapeHtml(row.dueAt)}</td>
<td>${escapeHtml(row.error ?? "-")}</td>
</tr>`
          )
          .join("");

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
  <body>
    <main>
      <section class="hero">
        <div>
          <h1>Symphony Runtime</h1>
          <p>Workflow: <code>${escapeHtml(snapshot.workflow.path)}</code></p>
        </div>
        <div class="stats">
          <div class="card">
            <div class="label">Running</div>
            <div class="value">${snapshot.counts.running}</div>
          </div>
          <div class="card">
            <div class="label">Retrying</div>
            <div class="value">${snapshot.counts.retrying}</div>
          </div>
          <div class="card">
            <div class="label">Total Tokens</div>
            <div class="value">${snapshot.codexTotals.totalTokens}</div>
          </div>
          <div class="card">
            <div class="label">Runtime Seconds</div>
            <div class="value">${snapshot.codexTotals.secondsRunning.toFixed(1)}</div>
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
          <tbody>${runningRows}</tbody>
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
          <tbody>${retryRows}</tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
