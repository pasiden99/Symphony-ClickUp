# HTTP Dashboard

## Purpose
This page documents the optional local Fastify server that exposes Symphony runtime state as a human-readable HTML dashboard and a small JSON API.

## Covered Paths
- `src/http.ts`

## Responsibilities
- Construct the Fastify application around an orchestrator-like runtime source.
- Expose the runtime snapshot and per-issue snapshot over JSON.
- Expose recent audit events over JSON.
- Expose live runtime snapshot and audit streams over server-sent events.
- Render a compact operator-facing dashboard for local use.
- Keep the HTTP surface read-mostly, with one explicit refresh action and one live stream.

## Control and Data Flow

1. `startHttpServer()` receives the orchestrator-compatible runtime source, logger, and port number.
2. `createHttpServer()` builds a Fastify app whose logger is a child logger with `component: "http_server"`.
3. Routes are registered:
   - `GET /` renders the current `RuntimeSnapshot` into HTML.
   - `GET /favicon.ico` returns `204` to avoid browser noise.
   - `GET /api/v1/state` returns the raw `RuntimeSnapshot`.
   - `GET /api/v1/audit` returns filtered recent `AuditEvent`s.
   - `GET /api/v1/events` opens an SSE stream that sends `snapshot` and `audit` events plus heartbeat comments.
   - `GET /api/v1/:issue_identifier/audit` returns filtered recent `AuditEvent`s for one issue.
   - `GET /api/v1/:issue_identifier` returns `IssueRuntimeSnapshot` or a structured `404`.
   - `POST /api/v1/refresh` requests a reconcile/poll cycle and returns a `202` payload describing whether the request was coalesced.
4. `/api/v1/events` subscribes to `subscribeRuntimeSnapshots()` and `subscribeAuditEvents()` on the orchestrator-compatible source, writes an initial snapshot immediately, emits `retry: 2000`, and sends a heartbeat every 15 seconds to keep the connection warm.
5. `renderDashboard()` turns the snapshot and recent audit page into a single HTML page with:
   - high-level counts,
   - token totals,
   - blocked and recent-failure counts,
   - active-run table,
   - retry-queue table,
   - rate-limit panel,
   - filterable audit timeline,
   - event/run detail panel,
   - a live-status indicator.
6. The dashboard embeds a small browser-side script that:
   - opens `EventSource('/api/v1/events')`,
   - updates DOM nodes in place when new snapshots or audit events arrive,
   - filters and searches the audit timeline client-side,
   - shows connected and reconnecting state,
   - degrades gracefully when `EventSource` is unavailable.
7. `escapeHtml()` protects interpolated values before they are injected into the HTML response.

Current dashboard characteristics:

- Binds only to `127.0.0.1`.
- Uses the runtime snapshot already maintained by the orchestrator; it does not own its own caching or polling layer.
- Depends on the orchestrator-compatible source exposing runtime and audit getters/subscriptions.
- Is intentionally small and local-first, not a multi-user control plane.

## Important Exports and Classes

| Path | Export or class | Notes |
| --- | --- | --- |
| `src/http.ts` | `HttpRuntimeSource` | Minimal interface the orchestrator must satisfy |
| `src/http.ts` | `createHttpServer()` | Builds the Fastify app without listening |
| `src/http.ts` | `startHttpServer()` | Binds the app to `127.0.0.1:{port}` |

## Inputs and Outputs
- Inputs:
  - `RuntimeSnapshot`
  - `IssueRuntimeSnapshot`
  - `AuditEventPage`
  - runtime snapshot subscription callbacks
  - audit event subscription callbacks
  - refresh requests from operators or scripts
- Outputs:
  - local HTML at `/`
  - JSON payloads at `/api/v1/state`, `/api/v1/audit`, `/api/v1/:issue_identifier`, `/api/v1/:issue_identifier/audit`, and `/api/v1/refresh`
  - SSE `snapshot` and `audit` events at `/api/v1/events`

## Failure Modes
- Unknown issue identifiers return `404` with an `issue_not_found` error payload.
- Port-binding failures bubble out of `startHttpServer()` and fail startup when the HTTP server is enabled.
- If the orchestrator reports empty running, retry, or audit arrays, the dashboard renders explicit empty states instead of blank panels.
- If the SSE stream closes or errors, the browser client falls back to reconnecting behavior and updates the live-status label accordingly.
- Browsers without `EventSource` still receive the initial HTML snapshot but do not get live updates.

## Related Tests
- `tests/http.test.ts`

Coverage note: the current test suite covers the dashboard shell, EventSource bootstrap, favicon suppression, snapshot SSE streaming, audit routes, and audit SSE streaming, but it still does not deeply validate every HTML state transition.

## Related Docs
- [System Overview](../architecture/system-overview.md)
- [Domain Model](../architecture/domain-model.md)
- [Codebase Map](../codebase-map.md)
