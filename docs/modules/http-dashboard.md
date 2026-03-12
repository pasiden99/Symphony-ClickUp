# HTTP Dashboard

## Purpose
This page documents the optional local Fastify server that exposes Symphony runtime state as a human-readable HTML dashboard and a small JSON API.

## Covered Paths
- `src/http.ts`

## Responsibilities
- Construct the Fastify application around an orchestrator-like runtime source.
- Expose the runtime snapshot and per-issue snapshot over JSON.
- Render a simple operator-facing dashboard for local use.
- Keep the HTTP surface read-mostly, with one explicit refresh action.

## Control and Data Flow

1. `startHttpServer()` receives the orchestrator-compatible runtime source, logger, and port number.
2. `createHttpServer()` builds a Fastify app whose logger is a child logger with `component: "http_server"`.
3. Routes are registered:
   - `GET /` renders the current `RuntimeSnapshot` into HTML.
   - `GET /favicon.ico` returns `204` to avoid browser noise.
   - `GET /api/v1/state` returns the raw `RuntimeSnapshot`.
   - `GET /api/v1/:issue_identifier` returns `IssueRuntimeSnapshot` or a structured `404`.
   - `POST /api/v1/refresh` requests a reconcile/poll cycle and returns a `202` payload describing whether the request was coalesced.
4. `renderDashboard()` turns the snapshot into a single HTML page with:
   - high-level counts,
   - token totals,
   - runtime seconds,
   - active-run table,
   - retry-queue table.
5. `escapeHtml()` protects interpolated values before they are injected into the HTML response.

Current dashboard characteristics:

- Binds only to `127.0.0.1`.
- Uses the runtime snapshot already maintained by the orchestrator; it does not own its own caching or polling layer.
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
  - refresh requests from operators or scripts
- Outputs:
  - local HTML at `/`
  - JSON payloads at `/api/v1/state`, `/api/v1/:issue_identifier`, and `/api/v1/refresh`

## Failure Modes
- Unknown issue identifiers return `404` with an `issue_not_found` error payload.
- Port-binding failures bubble out of `startHttpServer()` and fail startup when the HTTP server is enabled.
- If the orchestrator reports empty running or retry arrays, the dashboard renders explicit "No active runs" and "No queued retries" rows instead of blank tables.
- The dashboard is static HTML from the current snapshot; it does not push updates to the browser.

## Related Tests
- `tests/http.test.ts`

Coverage note: the current test suite checks the dashboard shell and favicon suppression, but it does not deeply validate the HTML table rendering or refresh-route payload contents.

## Related Docs
- [System Overview](../architecture/system-overview.md)
- [Domain Model](../architecture/domain-model.md)
- [Codebase Map](../codebase-map.md)
