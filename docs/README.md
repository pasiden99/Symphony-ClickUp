# Symphony Codebase Docs

## Purpose
This directory is the maintainers' map of the Symphony codebase. It supplements the root `README.md`, which stays focused on setup and operation, by documenting how the implementation is structured, how runtime data moves through the service, and which files own each behavior.

## Covered Paths
- `docs/codebase-map.md`
- `docs/architecture/system-overview.md`
- `docs/architecture/domain-model.md`
- `docs/modules/bootstrap-and-config.md`
- `docs/modules/orchestration-and-workspaces.md`
- `docs/modules/codex-integration.md`
- `docs/modules/clickup-integration.md`
- `docs/modules/http-dashboard.md`
- `docs/testing/test-map.md`
- `docs/reference/workflow-contract.md`
- `docs/reference/legacy-spec.md`

## Responsibilities
- Provide a stable reading order for new contributors.
- Point each subsystem description back to the exact source and test files that implement it.
- Separate current implementation docs from historical design material.
- Make repo navigation faster by keeping one hand-maintained map of the authored code surface.

## Control and Data Flow
Recommended reading order:

1. Start with [Codebase Map](./codebase-map.md) for the authored tree and file inventory.
2. Read [System Overview](./architecture/system-overview.md) for the end-to-end runtime lifecycle.
3. Read [Domain Model](./architecture/domain-model.md) to understand the shared types and runtime snapshots.
4. Use the module pages for implementation details:
   - [Bootstrap and Config](./modules/bootstrap-and-config.md)
   - [Orchestration and Workspaces](./modules/orchestration-and-workspaces.md)
   - [Codex Integration](./modules/codex-integration.md)
   - [ClickUp Integration](./modules/clickup-integration.md)
   - [HTTP Dashboard](./modules/http-dashboard.md)
5. Use [Test Map](./testing/test-map.md) to see what behavior is covered by Vitest and where coverage is thin.
6. Use [Workflow Contract](./reference/workflow-contract.md) for the repository-owned `WORKFLOW.md` interface.
7. Use [Legacy Spec](./reference/legacy-spec.md) only for historical background.

Documentation conventions:

- Each page uses the same section order so readers can skim consistently.
- Paths listed under "Covered Paths" are the primary source-of-truth files for that page.
- Generated and local-only paths are called out, but they are not described as first-class implementation surfaces.

## Important Exports and Classes
Primary runtime entrypoints worth knowing before diving into subsystem pages:

| Path | Entry point |
| --- | --- |
| `src/cli.ts` | `main()` parses CLI args and starts the service |
| `src/service.ts` | `SymphonyService` owns startup, reload, shutdown, and optional HTTP startup |
| `src/orchestrator.ts` | `Orchestrator` owns poll ticks, dispatch, reconciliation, and retries |
| `src/agent-runner.ts` | `AgentRunner` owns one workspace-bound Codex attempt |
| `src/codex/client.ts` | `CodexAppServerClient` and `CodexSession` bridge Symphony to Codex app-server |
| `src/tracker/clickup.ts` | `ClickUpTrackerClient` fetches and normalizes tracker data |

## Inputs and Outputs
- Inputs:
  - The authored repository files under `src/`, `tests/`, and the root workflow/config files.
  - Runtime behavior observed in the current TypeScript implementation.
- Outputs:
  - A consistent navigation hub for maintainers.
  - Cross-linked subsystem references tied back to tests and workflow docs.

## Failure Modes
- Documentation can drift if large runtime changes land without updating the matching module page.
- The historical spec can mislead readers if it is treated as current behavior instead of archived context.
- Local-only files such as `.env.local` and generated outputs such as `dist/` can confuse ownership boundaries if they are mistaken for authored source.

## Related Tests
- Documentation changes are not validated by a dedicated test suite.
- Use [Test Map](./testing/test-map.md) to trace behavior-level coverage back to Vitest suites.

## Related Docs
- [Codebase Map](./codebase-map.md)
- [System Overview](./architecture/system-overview.md)
- [Domain Model](./architecture/domain-model.md)
- [Bootstrap and Config](./modules/bootstrap-and-config.md)
- [Orchestration and Workspaces](./modules/orchestration-and-workspaces.md)
- [Codex Integration](./modules/codex-integration.md)
- [ClickUp Integration](./modules/clickup-integration.md)
- [HTTP Dashboard](./modules/http-dashboard.md)
- [Test Map](./testing/test-map.md)
- [Workflow Contract](./reference/workflow-contract.md)
- [Legacy Spec](./reference/legacy-spec.md)
