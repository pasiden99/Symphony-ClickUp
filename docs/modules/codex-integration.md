# Codex Integration

## Purpose
This page explains how Symphony launches Codex app-server, turns workflow prompts into live turns, handles server requests, and exposes first-party ClickUp tools to the agent.

## Covered Paths
- `src/codex/client.ts`
- `src/codex/dynamic-tools.ts`

## Responsibilities

| Path | Responsibility |
| --- | --- |
| `src/codex/client.ts` | Spawn Codex, initialize the session, manage JSON request/response state, emit events, and normalize sandbox policy |
| `src/codex/dynamic-tools.ts` | Define first-party ClickUp tools and translate tool calls into ClickUp REST requests |

## Control and Data Flow

1. `CodexAppServerClient.startSession()` creates a `CodexSession`.
2. `CodexSession.start()` spawns the configured shell command in the workspace directory and starts stdout/stderr readers.
3. `initialize()` sends:
   - `initialize`
   - `initialized`
   - `thread/start`
4. When dynamic tools are available, `startThread()` tries three registration field names in order:
   - `dynamicTools`
   - `dynamic_tools`
   - `tools`
   If all fail, Symphony falls back to a thread start without tools and emits `dynamic_tools_unavailable`.
5. `runTurn()` sends `turn/start` with:
   - thread ID
   - prompt text
   - title
   - `approvalPolicy`
   - the normalized turn sandbox policy returned by `materializeTurnSandboxPolicy()`
6. Notifications from the server are converted into `LiveSessionEvent`s, including token usage and rate-limit data when present.
7. Server-initiated requests are handled with explicit policy:
   - approval-related requests are auto-approved,
   - `requestUserInput` requests receive empty answers and fail the active turn with `turn_input_required`,
   - `tool/call` requests are routed through `DynamicToolHandler`,
   - unsupported requests get a simple error result.
8. `ClickUpDynamicToolHandler` exposes four tools:
   - `clickup_get_task`
   - `clickup_update_task`
   - `clickup_get_task_comments`
   - `clickup_create_task_comment`
9. Tool responses are wrapped as `DynamicToolResponse` objects with JSON-serialized `contentItems` so the app-server can feed them back into the turn.
10. `close()` tears down pending requests, rejects active work, sends `SIGTERM`, waits briefly, then escalates to `SIGKILL` if needed.

Sandbox normalization behavior in `materializeTurnSandboxPolicy()`:

- Supports workspace-write policies in either `workspaceWrite` or `workspace-write` style.
- Always adds the workspace root and `.git` to writable roots.
- Normalizes read-only access into either `fullAccess` or restricted readable roots.
- Translates booleans for network access and temp-dir exclusions.
- Also understands `danger-full-access` and `read-only` variants.

Dynamic tool behavior details:

- `clickup_update_task` accepts `status`, `name`, `description`, and `markdownDescription`.
- `clickup_get_task_comments` accepts optional pagination via `start` and `startId`.
- `resolveTaskId()` transparently converts the current Symphony issue identifier into the raw ClickUp task ID when needed.
- Tool-call errors are surfaced as structured failure JSON instead of throwing across the app-server boundary.

## Important Exports and Classes

| Path | Export or class | Notes |
| --- | --- | --- |
| `src/codex/client.ts` | `CodexAppServerClient` | Thin factory for `CodexSession` |
| `src/codex/client.ts` | `CodexSession` | Live spawned Codex process plus request/notification handling |
| `src/codex/client.ts` | `StartSessionOptions`, `RunTurnOptions`, `CodexTurnResult` | Main transport contracts |
| `src/codex/client.ts` | `materializeTurnSandboxPolicy()` | Normalizes turn sandbox config for the current workspace |
| `src/codex/dynamic-tools.ts` | `ClickUpDynamicToolHandler` | First-party ClickUp tool implementation |
| `src/codex/dynamic-tools.ts` | `DynamicToolSpec`, `DynamicToolResponse`, `DynamicToolHandler` | Dynamic tool contracts |

## Inputs and Outputs
- Inputs:
  - `CodexConfig`
  - workspace path
  - prompt text and issue title
  - optional dynamic tool handler
  - tool-call arguments from the Codex server
- Outputs:
  - `LiveSessionEvent` stream
  - `CodexTurnResult`
  - ClickUp-backed tool call results
  - normalized sandbox policies sent to Codex

## Failure Modes
- `response_timeout` fires when a request to Codex app-server does not resolve within `readTimeoutMs`.
- `turn_timeout` fires when an active turn exceeds `turnTimeoutMs`.
- `port_exit` fires when the child process exits unexpectedly or closes during pending work.
- malformed JSON lines on stdout emit a `malformed` event and are skipped.
- `requestUserInput` is intentionally non-interactive; it fails the active turn so unattended runs do not hang waiting for operator input.
- Unsupported tool calls return a structured failure payload instead of crashing the session.
- ClickUp API failures inside `ClickUpDynamicToolHandler` return tool-level failure JSON and are logged as `dynamic_tool_call_failed`.

## Related Tests
- `tests/codex-client.test.ts`
- `tests/clickup-dynamic-tools.test.ts`
- `tests/fixtures/fake-codex-app-server.mjs`
- `tests/fixtures/fake-codex-app-server-legacy-tools.mjs`

## Related Docs
- [System Overview](../architecture/system-overview.md)
- [Orchestration and Workspaces](./orchestration-and-workspaces.md)
- [ClickUp Integration](./clickup-integration.md)
- [Workflow Contract](../reference/workflow-contract.md)
