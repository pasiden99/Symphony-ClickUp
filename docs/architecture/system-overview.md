# System Overview

## Purpose
This page explains the full runtime lifecycle of Symphony, from CLI startup through workflow loading, issue polling, Codex execution, optional HTTP serving, hot reload, and shutdown.

## Covered Paths
- `src/cli.ts`
- `src/service.ts`
- `src/orchestrator.ts`
- `src/agent-runner.ts`
- `src/workspace.ts`
- `src/codex/client.ts`
- `src/tracker/clickup.ts`
- `src/http.ts`

## Responsibilities
- Show how the top-level runtime stages connect.
- Clarify which class owns each phase of the lifecycle.
- Separate startup work from per-tick orchestration and per-attempt execution.

## Control and Data Flow
End-to-end runtime flow:

1. `src/cli.ts` resolves the workflow path, loads environment files relative to that workflow, parses `--port`, and constructs `SymphonyService`.
2. `SymphonyService.start()` in `src/service.ts` loads `WORKFLOW.md`, resolves the effective runtime config, constructs `WorkspaceManager`, a ClickUp tracker factory, `AgentRunner`, and `Orchestrator`, then starts the orchestrator.
3. `Orchestrator.start()` validates dispatch config, removes stale workspaces for issues already in terminal states, and schedules the first poll tick immediately.
4. Each orchestrator tick:
   - reconciles currently running issues,
   - checks for stalled runs,
   - re-validates config,
   - fetches ClickUp candidate issues,
   - sorts them by priority and age,
   - dispatches as many eligible issues as concurrency allows.
5. Dispatch hands one normalized `Issue` to `AgentRunner.runAttempt()`.
6. `AgentRunner`:
   - ensures the workspace exists,
   - removes transient artifacts such as `tmp` and `.elixir_ls`,
   - runs workspace hooks,
   - performs environment preflight checks such as `gh auth status`,
   - starts a `CodexSession`,
   - renders the first prompt from `WORKFLOW.md`,
   - runs continuation turns until the task leaves an active state or `agent.maxTurns` is reached.
7. `CodexSession` in `src/codex/client.ts` speaks line-delimited JSON to the Codex app-server process, advertises first-party dynamic tools if the server accepts them, and emits session events back to the orchestrator.
8. The orchestrator converts session events into live runtime snapshots, token totals, rate-limit telemetry, blocked-pending-external-change state, and retry scheduling decisions.
9. If a turn fails because Codex requested interactive input, the agent attempt returns `blocked`; the orchestrator records that issue as blocked until ClickUp state or `updatedAt` changes instead of immediately retrying the same work.
10. If the configured HTTP server is enabled, `src/http.ts` exposes the runtime snapshot as HTML and JSON on `127.0.0.1`, plus a server-sent event stream for live dashboard updates.
11. The dashboard page uses `EventSource` against `/api/v1/events` so it can update counts and tables without a full page reload.
12. `watchWorkflow()` keeps watching `WORKFLOW.md`; a change triggers `SymphonyService.reloadWorkflow()`, which swaps in a new workflow/config for future work without killing in-flight turns.
13. Shutdown from `SIGINT` or `SIGTERM` closes the watcher, aborts running sessions, clears retry timers, clears runtime snapshot listeners, stops the HTTP server, and exits the process.

Key ownership boundaries:

- `SymphonyService` owns process-level lifecycle.
- `Orchestrator` owns scheduling state, blocked-until-change tracking, and retry logic.
- `AgentRunner` owns a single issue attempt.
- `WorkspaceManager` owns filesystem safety and hook execution.
- `CodexSession` owns app-server transport.
- `ClickUpTrackerClient` owns tracker reads and normalization.
- `createHttpServer()` owns the operator dashboard surface.

## Important Exports and Classes

| Path | Export or class | Role |
| --- | --- | --- |
| `src/cli.ts` | `main()` | Entry point that builds and starts the service |
| `src/service.ts` | `SymphonyService` | Process-level owner of startup, reload, and shutdown |
| `src/orchestrator.ts` | `Orchestrator` | Poll loop, running claims, reconciliation, retries, snapshots |
| `src/agent-runner.ts` | `AgentRunner` | One issue attempt across one workspace and one live Codex session |
| `src/workspace.ts` | `WorkspaceManager` | Workspace creation, cleanup, and hook lifecycle |
| `src/codex/client.ts` | `CodexAppServerClient`, `CodexSession` | App-server session transport and event bridge |
| `src/tracker/clickup.ts` | `ClickUpTrackerClient` | ClickUp task reads and normalization |
| `src/http.ts` | `createHttpServer()`, `startHttpServer()` | Local dashboard and JSON API |

## Inputs and Outputs
- Inputs:
  - CLI args: optional workflow path and `--port`.
  - Workflow config and prompt template from `WORKFLOW.md`.
  - Environment variables from `.env`, `.env.local`, and the process environment.
  - ClickUp task data and task-state refreshes.
  - Codex app-server events over stdio.
- Outputs:
  - Workspace folders under `workspace.root`.
  - Structured logs via Pino.
  - Runtime state snapshots for the HTTP dashboard.
  - Retry timers and claim state in memory.

## Failure Modes
- Startup fails if workflow loading or config resolution fails before `SymphonyService` can construct the runtime.
- Candidate fetch failures skip dispatch for the tick but do not crash the service.
- Stalled turns are canceled by reconciliation and converted into retries.
- Interactive-input-required turns are not retried immediately; they become blocked until the ClickUp task changes.
- Invalid workflow reloads are recorded as `lastConfigError`; the service keeps running with the prior good config.
- HTTP startup can fail independently if the port cannot be bound.

## Related Tests
- `tests/orchestrator.test.ts`
- `tests/codex-client.test.ts`
- `tests/http.test.ts`
- `tests/config.test.ts`
- `tests/workflow.test.ts`

## Related Docs
- [Codebase Map](../codebase-map.md)
- [Domain Model](./domain-model.md)
- [Bootstrap and Config](../modules/bootstrap-and-config.md)
- [Orchestration and Workspaces](../modules/orchestration-and-workspaces.md)
- [Codex Integration](../modules/codex-integration.md)
- [ClickUp Integration](../modules/clickup-integration.md)
- [HTTP Dashboard](../modules/http-dashboard.md)
