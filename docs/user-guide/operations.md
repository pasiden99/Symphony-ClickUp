# Operations Guide

This page covers normal runtime behavior, dashboard access, scripts, and the recommended first run.

## Day-to-Day Behavior

These runtime rules are built into the app:

- Symphony only dispatches tasks in active statuses.
- Tasks in `Todo` with unfinished blockers are skipped until their blockers reach a terminal state.
- Each task gets a stable workspace folder based on its issue identifier.
- Successful runs are re-queued quickly if the task still remains active.
- Failed or stalled runs retry with exponential backoff.
- Runs that fail because Codex requested interactive input are marked blocked and held until the task changes in ClickUp.
- If a running task moves to a terminal status, Symphony cancels the run and cleans up that task workspace.
- On startup, Symphony also removes workspaces for tasks already in terminal statuses.
- Changes to `WORKFLOW.md` are reloaded automatically while Symphony is running.
- If you change the HTTP port, restart Symphony. The server does not re-bind to a new port automatically.

## Dashboard and API

When the HTTP server is enabled, Symphony binds to `127.0.0.1` only.

Available routes:

| Route | Method | What it does |
| --- | --- | --- |
| `/` | `GET` | Human-friendly HTML dashboard |
| `/api/v1/state` | `GET` | Full runtime snapshot as JSON |
| `/api/v1/audit` | `GET` | Recent persisted audit events, with optional `limit`, `issue_identifier`, `category`, `level`, and `q` filters |
| `/api/v1/events` | `GET` | Server-sent event stream of runtime snapshots and audit events for live dashboard updates |
| `/api/v1/:issue_identifier/audit` | `GET` | Recent persisted audit events for one Symphony issue identifier |
| `/api/v1/:issue_identifier` | `GET` | Status for one Symphony issue identifier such as `CU-123` |
| `/api/v1/refresh` | `POST` | Queue an immediate poll/reconcile cycle |

The dashboard uses `EventSource` against `/api/v1/events`, so counts, tables, and the audit timeline update live without a manual refresh.

Examples:

```bash
curl http://127.0.0.1:3000/api/v1/state
```

```bash
curl -N http://127.0.0.1:3000/api/v1/events
```

```bash
curl 'http://127.0.0.1:3000/api/v1/audit?level=error&limit=50'
```

```bash
curl http://127.0.0.1:3000/api/v1/CU-123/audit
```

```bash
curl http://127.0.0.1:3000/api/v1/CU-123
```

```bash
curl -X POST http://127.0.0.1:3000/api/v1/refresh
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled CLI |
| `npm run typecheck` | Run TypeScript checks without building |
| `npm test` | Run the Vitest test suite |

The real Chromium screenshot smoke test is gated because it requires installed Playwright browsers:

```bash
RUN_PLAYWRIGHT_SCREENSHOT_TEST=1 npm test -- tests/screenshot-capturer.test.ts
```

## Recommended First Run

If you are setting this up for the first time, this order works well:

1. `npm install`
2. `cp .env.example .env.local`
3. `cp WORKFLOW-EXAMPLE.md WORKFLOW.md`
4. Fill in your ClickUp IDs and token
5. Build with `npm run build`
6. Start with `npm start -- --port 3000`
7. Open the dashboard and confirm Symphony sees the expected tasks
