# Domain Model

## Purpose
This page documents the shared data shapes that make Symphony coherent across bootstrap, orchestration, Codex execution, HTTP rendering, and ClickUp integration.

## Covered Paths
- `src/types.ts`
- `src/orchestrator.ts`
- `src/tracker/clickup.ts`
- `src/config.ts`
- `src/workflow.ts`
- `src/prompt.ts`

## Responsibilities
- Explain the normalized issue model used everywhere after ClickUp data enters the system.
- Describe the typed runtime config and runtime snapshot contracts.
- Call out which state is public through shared interfaces and which state stays private inside the orchestrator.

## Control and Data Flow
Primary model flow:

1. Raw ClickUp JSON enters through `ClickUpTrackerClient`.
2. `normalizeTask()` converts it into the shared `Issue` interface.
3. `loadWorkflow()` and `parseWorkflow()` produce a `WorkflowDefinition`.
4. `resolveEffectiveConfig()` converts untyped workflow front matter into `EffectiveConfig`.
5. `AgentRunner` and `Orchestrator` consume `Issue`, `WorkflowDefinition`, and `EffectiveConfig` to run work.
6. `CodexSession` emits `LiveSessionEvent` updates.
7. The orchestrator folds those updates into `LiveSessionSnapshot`, `RetryEntry`, `RuntimeTotals`, and finally `RuntimeSnapshot` and `IssueRuntimeSnapshot` for the dashboard/API.

Important public models from `src/types.ts`:

| Type | Meaning |
| --- | --- |
| `BlockerRef` | Minimal tracker info for a dependency or blocker task |
| `Issue` | Fully normalized task used by prompts, scheduling, logs, and HTTP state |
| `WorkflowDefinition` | Parsed workflow path, config object, prompt template, and load timestamp |
| `EffectiveConfig` | Fully typed runtime configuration after defaults and env resolution |
| `WorkspaceInfo` | Result of ensuring a workspace exists for an issue |
| `RunAttemptResult` | Outcome of one `AgentRunner` attempt |
| `LiveSessionEvent` | Raw session event data flowing from Codex to the orchestrator |
| `LiveSessionSnapshot` | Orchestrator-owned current session summary for one running issue |
| `RetryEntry` | Scheduled retry metadata |
| `RuntimeSnapshot` | Whole-service HTTP/dashboard view |
| `IssueRuntimeSnapshot` | Per-issue HTTP/dashboard view |
| `TrackerClient` | Minimal tracker interface consumed by the orchestrator |

Private orchestrator-only models in `src/orchestrator.ts`:

- `RunningEntry`: live in-memory running attempt state, including cancellation reason and abort controller.
- `RetryState`: `RetryEntry` plus the active timer handle.
- `IssueTrackingState`: durable per-issue bookkeeping used for recent events and attempt counts.

## Important Exports and Classes

| Path | Export | Notes |
| --- | --- | --- |
| `src/types.ts` | `Issue` | Core normalized work item shape |
| `src/types.ts` | `WorkflowDefinition` | Parsed repo-owned workflow contract |
| `src/types.ts` | `EffectiveConfig` | Typed runtime config used everywhere after startup |
| `src/types.ts` | `RunAttemptResult` | Contract between `AgentRunner` and `Orchestrator` |
| `src/types.ts` | `RuntimeSnapshot`, `IssueRuntimeSnapshot` | Public HTTP/dashboard state shapes |
| `src/types.ts` | `TrackerClient` | Integration boundary for tracker adapters |

## Inputs and Outputs
- Inputs:
  - Untyped YAML front matter from `WORKFLOW.md`.
  - Raw ClickUp task payloads.
  - Codex notifications and tool-call outcomes.
- Outputs:
  - Stronger internal models that reduce branching elsewhere in the codebase.
  - Predictable runtime snapshots for the dashboard and API.
  - Stable interfaces that test suites can fake without booting the full service.

## Failure Modes
- If ClickUp returns malformed task data, normalization throws `SymphonyError` and the bad task is skipped with a warning.
- If workflow front matter is missing required fields or contains unsupported tracker settings, `resolveEffectiveConfig()` throws before dispatch.
- If prompt rendering references unknown variables, `renderIssuePrompt()` fails the attempt rather than silently degrading the prompt.
- Because `RunningEntry`, `RetryState`, and `IssueTrackingState` are private, docs must treat them as implementation detail rather than public API.

## Related Tests
- `tests/config.test.ts`
- `tests/workflow.test.ts`
- `tests/prompt.test.ts`
- `tests/clickup-tracker.test.ts`
- `tests/http.test.ts`

## Related Docs
- [System Overview](./system-overview.md)
- [Bootstrap and Config](../modules/bootstrap-and-config.md)
- [Orchestration and Workspaces](../modules/orchestration-and-workspaces.md)
- [ClickUp Integration](../modules/clickup-integration.md)
- [HTTP Dashboard](../modules/http-dashboard.md)
