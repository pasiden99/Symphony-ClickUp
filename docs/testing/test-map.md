# Test Map

## Purpose
This page maps the Vitest suite to the runtime behaviors it protects, the fixtures it uses, and the implementation areas that currently have little or no direct test coverage.

## Covered Paths
- `vitest.config.ts`
- `tests/`
- `tests/fixtures/`

## Responsibilities
- Show what each test file validates.
- Help maintainers find the right suite when changing a subsystem.
- Make current coverage gaps explicit.

## Control and Data Flow
Test execution flow:

1. `vitest.config.ts` runs tests in the Node environment and includes `tests/**/*.test.ts`.
2. Coverage reporters are configured for text and `lcov`.
3. Individual suites fake only the part of the runtime they need:
   - pure helpers are called directly,
   - the orchestrator is constructed with fake tracker and agent dependencies,
   - the HTTP server uses Fastify injection,
   - the Codex client uses fake app-server fixtures in `tests/fixtures/`.

Suite map:

| Test file | Covered behavior |
| --- | --- |
| `tests/clickup-dynamic-tools.test.ts` | Task reads, updates, comments, API path construction, and current-issue identifier remapping for dynamic tools |
| `tests/clickup-tracker.test.ts` | Paginated candidate fetches, blocker resolution, identifier normalization, and invalid workspace messaging |
| `tests/codex-client.test.ts` | Session start, turn completion, interactive-input failed-turn results, dynamic tool calls, and sandbox policy normalization |
| `tests/config.test.ts` | Config defaults, env-backed values, and required ClickUp scope validation |
| `tests/env.test.ts` | `.env` parsing, quoted values, inline comments, and `.env.local` precedence |
| `tests/http.test.ts` | Dashboard HTML response shell, EventSource client bootstrap, favicon suppression, and SSE snapshot streaming |
| `tests/orchestrator.test.ts` | Dispatch eligibility, continuation retries, blocker gating, blocked issue holding, snapshot notification coalescing, and failure retry behavior |
| `tests/prompt.test.ts` | Prompt rendering, continuation prompt wording, and environment preflight prefixing |
| `tests/shell.test.ts` | Login-shell selection and fallback |
| `tests/workflow.test.ts` | Workflow YAML parsing and default path resolution |

Fixture map:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/fake-codex-app-server.mjs` | Simulates a modern app-server for turn events, tool calls, and request-user-input behavior |
| `tests/fixtures/fake-codex-app-server-legacy-tools.mjs` | Simulates older tool-registration field compatibility for Codex dynamic tools |

## Important Exports and Classes
The test tree does not export public runtime APIs, but it heavily exercises these implementation classes and helpers:

- `Orchestrator`
- `CodexAppServerClient`
- `ClickUpTrackerClient`
- `ClickUpDynamicToolHandler`
- config, env, prompt, shell, and workflow helpers

## Inputs and Outputs
- Inputs:
  - Source files under `src/`
  - Fake JSON/HTTP data inside tests
  - Fake app-server behavior from fixtures
- Outputs:
  - Pass/fail confidence for the current runtime behavior
  - Text and `lcov` coverage reports when coverage is requested

## Failure Modes
- There is no dedicated unit coverage for `src/service.ts`, `src/workspace.ts`, `src/logging.ts`, `src/errors.ts`, `src/utils.ts`, or `src/index.ts`.
- The refresh route payload is still only lightly covered compared with the SSE path and dashboard shell.
- Workflow reload behavior is covered indirectly through the service design, not through a service-level integration test.
- Hook execution paths and workspace-root safety checks are not directly asserted in Vitest today.

## Related Tests
- `tests/clickup-dynamic-tools.test.ts`
- `tests/clickup-tracker.test.ts`
- `tests/codex-client.test.ts`
- `tests/config.test.ts`
- `tests/env.test.ts`
- `tests/http.test.ts`
- `tests/orchestrator.test.ts`
- `tests/prompt.test.ts`
- `tests/shell.test.ts`
- `tests/workflow.test.ts`

## Related Docs
- [Codebase Map](../codebase-map.md)
- [Bootstrap and Config](../modules/bootstrap-and-config.md)
- [Orchestration and Workspaces](../modules/orchestration-and-workspaces.md)
- [Codex Integration](../modules/codex-integration.md)
- [ClickUp Integration](../modules/clickup-integration.md)
- [HTTP Dashboard](../modules/http-dashboard.md)
