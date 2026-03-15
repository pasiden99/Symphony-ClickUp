# HTTP Dashboard

## Purpose
This page documents the optional local Fastify server that exposes Symphony runtime state as a human-readable HTML dashboard and a small JSON API.

## Covered Paths
- `src/http.ts`

## Responsibilities
- Construct the Fastify application around an orchestrator-like runtime source.
- Expose the runtime snapshot and per-issue snapshot over JSON.
- Expose a live runtime snapshot stream over server-sent events.
- Render a simple operator-facing dashboard for local use.
- Keep the HTTP surface read-mostly, with one explicit refresh action and one live stream.

## Control and Data Flow

1. `startHttpServer()` receives the orchestrator-compatible runtime source, logger, and port number.
2. `createHttpServer()` builds a Fastify app whose logger is a child logger with `component: "http_server"`.
3. Routes are registered:
   - `GET /` renders the current `RuntimeSnapshot` into HTML.
   - `GET /favicon.ico` returns `204` to avoid browser noise.
   - `GET /api/v1/state` returns the raw `RuntimeSnapshot`.
   - `GET /api/v1/events` opens an SSE stream that sends `snapshot` events and heartbeat comments.
   - `GET /api/v1/:issue_identifier` returns `IssueRuntimeSnapshot` or a structured `404`.
   - `POST /api/v1/refresh` requests a reconcile/poll cycle and returns a `202` payload describing whether the request was coalesced.
4. `/api/v1/events` subscribes to `subscribeRuntimeSnapshots()` on the orchestrator-compatible source, writes an initial snapshot immediately, emits `retry: 2000`, and sends a heartbeat every 15 seconds to keep the connection warm.
5. `renderDashboard()` turns the snapshot into a single HTML page with:
   - high-level counts,
   - token totals,
   - runtime seconds,
   - active-run table,
   - retry-queue table,
   - a live-status indicator.
6. The dashboard embeds a small browser-side script that:
   - opens `EventSource('/api/v1/events')`,
   - updates DOM nodes in place when new snapshots arrive,
   - shows connected and reconnecting state,
   - degrades gracefully when `EventSource` is unavailable.
7. `escapeHtml()` protects interpolated values before they are injected into the HTML response.

Current dashboard characteristics:

- Binds only to `127.0.0.1`.
- Uses the runtime snapshot already maintained by the orchestrator; it does not own its own caching or polling layer.
- Depends on the orchestrator-compatible source exposing `subscribeRuntimeSnapshots()` in addition to snapshot getters.
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
  - runtime snapshot subscription callbacks
  - refresh requests from operators or scripts
- Outputs:
  - local HTML at `/`
  - JSON payloads at `/api/v1/state`, `/api/v1/:issue_identifier`, and `/api/v1/refresh`
  - SSE `snapshot` events at `/api/v1/events`

## Failure Modes
- Unknown issue identifiers return `404` with an `issue_not_found` error payload.
- Port-binding failures bubble out of `startHttpServer()` and fail startup when the HTTP server is enabled.
- If the orchestrator reports empty running or retry arrays, the dashboard renders explicit "No active runs" and "No queued retries" rows instead of blank tables.
- If the SSE stream closes or errors, the browser client falls back to reconnecting behavior and updates the live-status label accordingly.
- Browsers without `EventSource` still receive the initial HTML snapshot but do not get live updates.

## Related Tests
- `tests/http.test.ts`

Coverage note: the current test suite covers the dashboard shell, EventSource bootstrap, favicon suppression, and SSE streaming, but it still does not deeply validate every HTML state transition or the refresh-route payload contents.

## Related Docs
- [System Overview](../architecture/system-overview.md)
- [Domain Model](../architecture/domain-model.md)
- [Codebase Map](../codebase-map.md)
