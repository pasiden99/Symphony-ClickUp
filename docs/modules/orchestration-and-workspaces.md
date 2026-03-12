# Orchestration and Workspaces

## Purpose
This page documents the core work engine of Symphony: how issues are selected, claimed, executed in isolated workspaces, retried, canceled, and turned into runtime snapshots.

## Covered Paths
- `src/orchestrator.ts`
- `src/agent-runner.ts`
- `src/workspace.ts`
- `src/prompt.ts`

## Responsibilities

| Path | Responsibility |
| --- | --- |
| `src/orchestrator.ts` | Poll ticks, dispatch eligibility, claim tracking, reconciliation, cancellation, retry scheduling, runtime snapshots |
| `src/agent-runner.ts` | One issue attempt across workspace prep, environment preflight, Codex turns, and tracker refreshes |
| `src/workspace.ts` | Workspace creation, root safety checks, hook execution, transient cleanup, and removal |
| `src/prompt.ts` | Render first-turn prompts and generate continuation prompts for later turns |

## Control and Data Flow

1. `Orchestrator.start()` validates config, performs startup cleanup for terminal issues, and schedules the first tick.
2. Each tick in `onTick()`:
   - calls `reconcileRunningIssues()`,
   - skips dispatch if validation fails,
   - fetches candidate ClickUp issues,
   - sorts by priority, creation time, then identifier,
   - dispatches issues while global and per-state slots are available.
3. `shouldDispatch()` blocks work when:
   - the issue is missing required fields,
   - the state is not active or is terminal,
   - the issue is already running or claimed,
   - concurrency limits are exhausted,
   - the issue is in `Todo` and has a non-terminal blocker.
4. `dispatchIssue()` creates a `RunningEntry`, claims the issue, cancels any pending retry, and starts `AgentRunner.runAttempt()`.
5. `AgentRunner.runAttempt()`:
   - ensures the workspace exists,
   - clears transient directories,
   - runs `beforeRun`,
   - performs GitHub CLI preflight,
   - starts a `CodexSession`,
   - renders the initial prompt with Liquid,
   - sends continuation prompts on subsequent turns,
   - refreshes the task state from ClickUp after each completed turn,
   - exits when the task is no longer active or the turn limit is reached.
6. `handleSessionEvent()` in the orchestrator updates live session metadata, token totals, rate-limit telemetry, and recent issue events.
7. `handleWorkerExit()` converts the attempt result into one of three scheduler outcomes:
   - continuation retry after success,
   - exponential backoff retry after failure or stall,
   - claim release after reconciliation-driven cancellation or non-retry terminal conditions.
8. Retry timers call `onRetryTimer()`, which re-fetches active candidates, checks capacity again, and either redispatches or releases the claim.
9. Workspace cleanup happens in two places:
   - on startup for already-terminal issues,
   - on reconciliation cancellation when a running issue becomes terminal and `cleanupWorkspace` is true.

Workspace lifecycle details from `src/workspace.ts`:

- Workspaces are named from a sanitized issue identifier.
- `afterCreate` runs only when the directory is first created.
- `beforeRun` can fail an attempt.
- `afterRun` and `beforeRemove` are best-effort and logged on failure.
- `assertInsideWorkspaceRoot()` prevents hooks or cleanup from escaping the configured root.

Prompt behavior from `src/prompt.ts`:

- `renderIssuePrompt()` renders the workflow body with strict Liquid semantics.
- `buildContinuationPrompt()` intentionally forbids `mcp__clickup__*` usage and repeats the raw ClickUp task ID to keep continuation turns aligned with Symphony tooling.
- `prependEnvironmentContext()` injects preflight notices, such as missing `gh` auth, only for the first turn.

## Important Exports and Classes

| Path | Export or class | Notes |
| --- | --- | --- |
| `src/orchestrator.ts` | `Orchestrator` | Central scheduler and runtime-state owner |
| `src/agent-runner.ts` | `AgentRunner` | Per-issue execution loop |
| `src/agent-runner.ts` | `RunAttemptOptions` | Inputs for one attempt |
| `src/workspace.ts` | `WorkspaceManager` | Filesystem owner for workspace safety and hooks |
| `src/prompt.ts` | `renderIssuePrompt()` | First-turn workflow prompt rendering |
| `src/prompt.ts` | `buildContinuationPrompt()` | Continuation-turn instructions |
| `src/prompt.ts` | `prependEnvironmentContext()` | Preflight-notice prefixing |

## Inputs and Outputs
- Inputs:
  - `Issue`
  - `EffectiveConfig`
  - `WorkflowDefinition.promptTemplate`
  - `TrackerClient`
  - live `LiveSessionEvent`s from Codex
- Outputs:
  - `RunAttemptResult`
  - `RuntimeSnapshot` and `IssueRuntimeSnapshot`
  - workspace directories and hook side effects
  - retry timers and claim state in memory

## Failure Modes
- Stalled runs are canceled when no Codex event arrives within `codex.stall_timeout_ms`.
- Reconciliation can cancel a run if the issue becomes terminal or leaves an active state.
- `beforeRun` and `afterCreate` hook failures fail the attempt; `afterCreate` also removes the newly created directory.
- `turn_timeout` from Codex becomes a `timed_out` attempt result.
- If the post-turn ClickUp refresh cannot find the current task, the attempt fails rather than continuing on stale state.
- There is currently no dedicated test suite for `workspace.ts`; hook and cleanup behaviors are documented but not directly unit-tested.

## Related Tests
- `tests/orchestrator.test.ts`
- `tests/prompt.test.ts`

Indirect coverage:

- `tests/codex-client.test.ts` validates the Codex session behavior that `AgentRunner` depends on.
- `tests/clickup-tracker.test.ts` validates the tracker normalization behavior that the orchestrator depends on.

## Related Docs
- [System Overview](../architecture/system-overview.md)
- [Domain Model](../architecture/domain-model.md)
- [Codex Integration](./codex-integration.md)
- [ClickUp Integration](./clickup-integration.md)
- [Workflow Contract](../reference/workflow-contract.md)
