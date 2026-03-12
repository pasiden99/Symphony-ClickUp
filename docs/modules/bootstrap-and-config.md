# Bootstrap and Config

## Purpose
This page documents the files that turn a shell invocation plus repository-owned workflow files into a running Symphony service with typed configuration and shared helper behavior.

## Covered Paths
- `src/cli.ts`
- `src/service.ts`
- `src/index.ts`
- `src/env.ts`
- `src/workflow.ts`
- `src/config.ts`
- `src/logging.ts`
- `src/errors.ts`
- `src/shell.ts`
- `src/utils.ts`

## Responsibilities

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Parse CLI args, resolve workflow path, load env files, and start the service |
| `src/service.ts` | Compose the runtime, start the orchestrator, start the optional HTTP server, and watch for workflow reloads |
| `src/index.ts` | Re-export `SymphonyService` for external package consumers |
| `src/env.ts` | Parse `.env` syntax and merge `.env` / `.env.local` with shell env precedence |
| `src/workflow.ts` | Resolve the workflow path, parse YAML front matter, and watch for file changes |
| `src/config.ts` | Convert workflow front matter into `EffectiveConfig`, apply defaults, and validate dispatch requirements |
| `src/logging.ts` | Build the shared Pino logger instance |
| `src/errors.ts` | Standardize error typing and error detail extraction |
| `src/shell.ts` | Pick the login shell used for hooks and spawned shell commands |
| `src/utils.ts` | Shared coercion, state normalization, path expansion, timing, and bounded-concurrency helpers |

## Control and Data Flow

1. `src/cli.ts` calls `parseArgs()` to extract an optional workflow path and `--port`.
2. `resolveWorkflowPath()` in `src/workflow.ts` resolves the explicit path or defaults to `WORKFLOW.md` in `process.cwd()`.
3. `loadProjectEnv()` in `src/env.ts` loads `.env` and `.env.local` from the workflow directory without overriding non-empty existing shell variables.
4. `SymphonyService.start()` loads the workflow, resolves the effective config, instantiates core runtime classes, and starts the orchestrator.
5. If `server.port` or `--port` is present, `SymphonyService` starts the Fastify server after the orchestrator is running.
6. `watchWorkflow()` keeps observing the workflow file. On changes, `reloadWorkflow()` repeats env loading, workflow parsing, and config resolution, then swaps the new config into the existing orchestrator.
7. Helper files support this process:
   - `src/errors.ts` gives the service a consistent machine-readable error type.
   - `src/shell.ts` chooses `$SHELL` or falls back to `bash`.
   - `src/utils.ts` handles repeated low-level operations such as state normalization and env-backed path expansion.

Notable config behavior from `src/config.ts`:

- `tracker.kind` must currently resolve to `clickup`.
- `tracker.api_key` defaults to `$CLICKUP_API_TOKEN`.
- `tracker.workspace_id` is required.
- At least one of `tracker.space_ids`, `tracker.folder_ids`, or `tracker.list_ids` must be present.
- `workspace.root` defaults to a temp-dir-backed `symphony_workspaces` path.
- `codex.command` defaults to `codex app-server`.
- `server.port` is optional and can be overridden at the CLI.

## Important Exports and Classes

| Path | Export or class | Notes |
| --- | --- | --- |
| `src/service.ts` | `SymphonyService` | Main runtime composition root |
| `src/service.ts` | `SymphonyServiceOptions` | Constructor input shape |
| `src/config.ts` | `resolveEffectiveConfig()` | Front matter to `EffectiveConfig` |
| `src/config.ts` | `validateDispatchConfig()` | Per-start and per-tick dispatch safety checks |
| `src/config.ts` | `isActiveState()`, `isTerminalState()`, `perStateConcurrencyLimit()` | Shared orchestration helpers |
| `src/env.ts` | `loadProjectEnv()`, `parseEnvFile()` | Environment loading and parsing |
| `src/workflow.ts` | `resolveWorkflowPath()`, `loadWorkflow()`, `parseWorkflow()`, `watchWorkflow()` | Workflow file contract |
| `src/logging.ts` | `createLogger()` | Shared Pino factory |
| `src/errors.ts` | `SymphonyError`, `isSymphonyError()`, `toErrorDetails()` | Structured error handling |
| `src/shell.ts` | `resolveLoginShell()` | Shell selection helper |
| `src/utils.ts` | `normalizeStateName()`, `expandPathLike()`, `delayForAttempt()`, `mapWithConcurrency()` and other helpers | Small shared primitives |
| `src/index.ts` | `SymphonyService` re-export | Package entry barrel |

## Inputs and Outputs
- Inputs:
  - `process.argv`
  - `WORKFLOW.md`
  - `.env` and `.env.local`
  - shell environment variables
- Outputs:
  - `WorkflowDefinition`
  - `EffectiveConfig`
  - a running `SymphonyService`
  - structured startup and reload logs

## Failure Modes
- `parseArgs()` throws if `--port` is missing a value or is not a non-negative integer.
- `parseEnvFile()` throws `invalid_env_file` when an env line is malformed.
- `loadWorkflow()` throws `missing_workflow_file` if the selected workflow path does not exist.
- `parseWorkflow()` throws on malformed YAML front matter or when the front matter is not a map.
- `resolveEffectiveConfig()` throws for unsupported tracker kinds, missing tracker auth, missing ClickUp workspace IDs, missing scope filters, or blank `codex.command`.
- `reloadWorkflow()` catches invalid reloads, records them via `applyInvalidWorkflow()`, and leaves the current runtime alive.

## Related Tests
- `tests/config.test.ts`
- `tests/env.test.ts`
- `tests/workflow.test.ts`
- `tests/shell.test.ts`

Coverage note: there is no dedicated `service.ts`, `logging.ts`, `errors.ts`, `index.ts`, or `utils.ts` suite today; those behaviors are exercised indirectly by other tests or by runtime use.

## Related Docs
- [System Overview](../architecture/system-overview.md)
- [Domain Model](../architecture/domain-model.md)
- [Workflow Contract](../reference/workflow-contract.md)
- [Codebase Map](../codebase-map.md)
