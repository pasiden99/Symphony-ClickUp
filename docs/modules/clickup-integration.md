# ClickUp Integration

## Purpose
This page documents the tracker adapter that reads ClickUp tasks for scheduling and converts ClickUp responses into the normalized issue model used everywhere else in Symphony.

## Covered Paths
- `src/tracker/clickup.ts`

## Responsibilities
- Fetch candidate tasks in active states.
- Fetch tasks by explicit state lists for startup cleanup.
- Refresh current state for already running issue IDs.
- Resolve blocker tasks when candidate tasks include dependencies.
- Normalize ClickUp-specific payloads into the shared `Issue` shape.

## Control and Data Flow

1. `fetchCandidateIssues()` calls `fetchTasksByStates()` with the configured active states, excluding closed tasks and enabling blocker resolution.
2. `fetchIssuesByStates()` uses the same path but allows closed tasks and skips blocker resolution, which is enough for startup terminal cleanup.
3. `fetchIssueStatesByIds()` fetches individual tasks concurrently with a limit of five and normalizes each result.
4. `fetchTasksByStates()` pages through `GET /team/{workspaceId}/task` until ClickUp reports `last_page` or the current page has fewer than 100 tasks.
5. Query parameters are assembled from config:
   - `statuses[]`
   - `space_ids[]`
   - `project_ids[]` for ClickUp folders
   - `list_ids[]`
   - `include_markdown_description=true`
6. If blocker resolution is enabled, `loadBlockers()` extracts blocker IDs from task dependencies and fetches those tasks concurrently.
7. `normalizeTask()` converts a `ClickUpTask` into `Issue`:
   - `id` comes from `task.id`
   - `identifier` prefers `custom_id`, then falls back to `CU-{id}`
   - `description` prefers `description`, falling back to `text_content`
   - tags are lowercased into `labels`
   - blockers become `BlockerRef[]`
   - timestamps are normalized to ISO strings
8. The orchestrator consumes normalized issues without needing to know ClickUp response details.

Request behavior:

- Every request includes `Authorization` and `Accept: application/json`.
- Requests use `AbortSignal.timeout(requestTimeoutMs)`.
- Debug logs record method, path, status, duration, and rate-limit headers.
- 429 responses become `clickup_api_rate_limit`.
- A 404 on `/team/{workspaceId}/task` becomes `clickup_invalid_workspace` with a tailored message explaining that the value must be the ClickUp Workspace/team ID.

## Important Exports and Classes

| Path | Export or class | Notes |
| --- | --- | --- |
| `src/tracker/clickup.ts` | `ClickUpTrackerClient` | Only tracker implementation in the current repo |

Internal-only payload shapes inside this file:

- `ClickUpTask`
- `ClickUpStatus`
- `ClickUpPriority`
- `ClickUpDependency`
- `ClickUpTeamTasksResponse`

These interfaces are intentionally local to the adapter because the rest of the codebase should only depend on the normalized `Issue` interface from `src/types.ts`.

## Inputs and Outputs
- Inputs:
  - `ClickUpTrackerConfig`
  - ClickUp REST responses from `/team/{workspaceId}/task` and `/task/{id}`
- Outputs:
  - `Issue[]` for candidate, terminal-state, and refresh calls
  - `SymphonyError` values for API and payload failures
  - debug log entries with rate-limit metadata

## Failure Modes
- Malformed task payloads raise `clickup_unknown_payload`.
- Network or fetch-layer failures raise `clickup_api_request`.
- Rate limiting raises `clickup_api_rate_limit`.
- A wrong `workspace_id` on the team task route raises `clickup_invalid_workspace`.
- Individual task normalization failures are logged and filtered out instead of crashing the whole candidate page.
- Blocker fetch failures degrade gracefully to partial blocker information rather than failing the full candidate fetch.

## Related Tests
- `tests/clickup-tracker.test.ts`

Related behavior also appears in:

- `tests/orchestrator.test.ts`, which consumes normalized `Issue` objects.
- `tests/clickup-dynamic-tools.test.ts`, which validates the write-side ClickUp tools exposed to Codex rather than the tracker client itself.

## Related Docs
- [Domain Model](../architecture/domain-model.md)
- [Orchestration and Workspaces](./orchestration-and-workspaces.md)
- [Codex Integration](./codex-integration.md)
- [Workflow Contract](../reference/workflow-contract.md)
