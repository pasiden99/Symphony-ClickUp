# Codebase Map

## Purpose
This page is the hand-maintained inventory of the authored Symphony repository. It shows where each file lives, what it is responsible for, and which paths are intentionally treated as generated or local-only.

## Covered Paths
- Root project files
- `docs/`
- `src/`
- `tests/`
- Generated or local-only root paths that appear in the working tree

## Responsibilities
- Provide one quick tree view of the codebase.
- Ensure every authored `src/` file and every `tests/` file is named at least once.
- Distinguish authored source from generated output, dependency installs, and local machine files.

## Control and Data Flow
Annotated authored tree:

```text
.
├── .env.example                          # Checked-in environment example used by setup docs and workflow examples.
├── .gitignore                            # Git ignore rules for generated output, logs, local env files, and local `WORKFLOW.md`.
├── DROID_MEM_AGENT_INSTRUCTIONS.md       # Project guidance for droid-mem-enabled agents.
├── README.md                             # Operator-facing product, setup, and runtime usage guide.
├── SPEC.md                               # Small forwarding stub to the archived legacy spec under docs/reference/.
├── WORKFLOW-EXAMPLE.md                   # Example workflow contract with ClickUp + Codex settings.
├── WORKFLOW.md                           # Local active workflow used when running Symphony in this checkout; intentionally ignored by Git.
├── docs/
│   ├── README.md                         # Documentation hub and reading order.
│   ├── codebase-map.md                   # This file.
│   ├── architecture/
│   │   ├── domain-model.md               # Shared types, normalized models, and runtime snapshot shapes.
│   │   └── system-overview.md            # End-to-end runtime lifecycle.
│   ├── modules/
│   │   ├── bootstrap-and-config.md       # Startup, env loading, workflow parsing, config, and helpers.
│   │   ├── clickup-integration.md        # ClickUp tracker client behavior and normalization.
│   │   ├── codex-integration.md          # Codex app-server bridge and dynamic tool wiring.
│   │   ├── http-dashboard.md             # Fastify dashboard and JSON API.
│   │   └── orchestration-and-workspaces.md # Dispatch, retries, prompts, and workspace lifecycle.
│   ├── reference/
│   │   ├── legacy-spec.md                # Archived historical specification from the former root SPEC.md.
│   │   └── workflow-contract.md          # Current `WORKFLOW.md` and env contract.
│   └── testing/
│       └── test-map.md                   # Vitest suite map and fixture coverage.
├── package-lock.json                     # Locked npm dependency graph for reproducible installs.
├── package.json                          # Package metadata, runtime dependencies, scripts, and CLI bin mapping.
├── src/
│   ├── agent-runner.ts                   # One issue attempt: workspace prep, Codex session, turn loop, tracker refresh, and blocked-turn detection.
│   ├── cli.ts                            # Command-line entrypoint and `--port` parsing.
│   ├── config.ts                         # Workflow config resolution, defaults, and dispatch validation.
│   ├── env.ts                            # `.env` and `.env.local` parsing and load precedence.
│   ├── errors.ts                         # Shared `SymphonyError` type and error detail helpers.
│   ├── http.ts                           # Fastify HTTP server, dashboard HTML, JSON API routes, and live SSE snapshot streaming.
│   ├── index.ts                          # Public package barrel exporting `SymphonyService`.
│   ├── logging.ts                        # Pino logger factory.
│   ├── orchestrator.ts                   # Polling loop, reconciliation, claims, blocked-until-change state, retry timers, and snapshot listeners.
│   ├── prompt.ts                         # Liquid prompt rendering and continuation prompt helpers.
│   ├── service.ts                        # High-level lifecycle owner for startup, reload, shutdown, and HTTP server.
│   ├── shell.ts                          # Login-shell resolution helper for hooks and Codex spawn.
│   ├── types.ts                          # Shared domain, config, runtime snapshot, tracker interfaces, and blocked-status shapes.
│   ├── utils.ts                          # Small shared coercion, timing, path, and concurrency helpers.
│   ├── workflow.ts                       # `WORKFLOW.md` path resolution, parsing, and file watching.
│   ├── workspace.ts                      # Workspace creation, hook execution, cleanup, and root-safety checks.
│   ├── codex/
│   │   ├── client.ts                     # JSON-RPC-like Codex app-server session and turn transport.
│   │   └── dynamic-tools.ts              # First-party ClickUp tools advertised to Codex turns.
│   └── tracker/
│       └── clickup.ts                    # ClickUp API adapter and issue normalization layer.
├── tests/
│   ├── clickup-dynamic-tools.test.ts     # Dynamic tool request/response behavior and task-id resolution rules.
│   ├── clickup-tracker.test.ts           # ClickUp task fetching, pagination, blockers, and workspace-id errors.
│   ├── codex-client.test.ts              # Codex session lifecycle, blocked-input behavior, dynamic tools, and sandbox policy normalization.
│   ├── config.test.ts                    # Effective config defaults, env-backed values, and validation failures.
│   ├── env.test.ts                       # Env parsing and precedence between `.env`, `.env.local`, and shell vars.
│   ├── http.test.ts                      # Fastify dashboard HTML, EventSource client bootstrap, and SSE stream behavior.
│   ├── orchestrator.test.ts              # Dispatch gating, continuation retries, blocked issue holding, and snapshot notification behavior.
│   ├── prompt.test.ts                    # Liquid prompt data, continuation wording, and environment notice prefixing.
│   ├── shell.test.ts                     # Shell fallback logic.
│   ├── workflow.test.ts                  # Workflow front matter parsing and default path resolution.
│   └── fixtures/
│       ├── fake-codex-app-server-legacy-tools.mjs # Test server for older dynamic tool registration shapes.
│       └── fake-codex-app-server.mjs     # Test server for turn lifecycle, tool calls, and request-user-input flow.
├── tsconfig.json                         # TypeScript compiler settings and include paths.
└── vitest.config.ts                      # Vitest configuration and coverage reporter settings.
```

Generated or local-only paths that appear in this checkout:

- `dist/`: compiled JavaScript output from `npm run build`.
- `node_modules/`: installed npm dependencies.
- `.env.local`: local secrets and machine-specific overrides, intentionally ignored by Git.
- `WORKFLOW.md`: local runtime workflow file, intentionally ignored so operators can keep machine-specific state out of version control.
- `.DS_Store`: macOS Finder metadata, not part of the authored project.

## Important Exports and Classes
Useful navigation anchors from the tree above:

| File | Primary export or owner |
| --- | --- |
| `src/service.ts` | `SymphonyService` |
| `src/orchestrator.ts` | `Orchestrator` |
| `src/agent-runner.ts` | `AgentRunner` |
| `src/workspace.ts` | `WorkspaceManager` |
| `src/codex/client.ts` | `CodexAppServerClient`, `CodexSession`, `materializeTurnSandboxPolicy()` |
| `src/codex/dynamic-tools.ts` | `ClickUpDynamicToolHandler` |
| `src/tracker/clickup.ts` | `ClickUpTrackerClient` |
| `src/http.ts` | `createHttpServer()`, `startHttpServer()` |

## Inputs and Outputs
- Inputs:
  - Authored source in `src/`.
  - Tests and fixtures in `tests/`.
  - Root configuration and workflow files.
- Outputs:
  - Compiled artifacts in `dist/`.
  - Runtime workspaces outside the repo root, under `workspace.root`.
  - Optional local dashboard responses from `src/http.ts`.

## Failure Modes
- The tree can fall behind if files are added or renamed without updating this page.
- Local machine files can clutter the root and be mistaken for project-owned implementation files.
- Generated output can be confused with authored source if readers start from `dist/` instead of `src/`.

## Related Tests
- [Test Map](./testing/test-map.md) covers the test files listed in this tree.

## Related Docs
- [Symphony Codebase Docs](./README.md)
- [System Overview](./architecture/system-overview.md)
- [Bootstrap and Config](./modules/bootstrap-and-config.md)
- [Orchestration and Workspaces](./modules/orchestration-and-workspaces.md)
- [Codex Integration](./modules/codex-integration.md)
- [ClickUp Integration](./modules/clickup-integration.md)
- [HTTP Dashboard](./modules/http-dashboard.md)
