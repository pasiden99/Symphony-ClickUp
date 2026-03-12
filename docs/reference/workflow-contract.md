# Workflow Contract

## Purpose
This page documents the repository-owned contract between Symphony and `WORKFLOW.md`, including YAML front matter, prompt rendering, environment-file loading, and the example files that operators are expected to copy and customize.

## Covered Paths
- `WORKFLOW.md`
- `WORKFLOW-EXAMPLE.md`
- `.env.example`
- `src/workflow.ts`
- `src/env.ts`
- `src/config.ts`
- `src/prompt.ts`
- `README.md`

## Responsibilities
- Explain which parts of the repo are the operator-editable contract.
- Describe how Symphony loads and validates workflow and env data.
- Document the template variables and front matter keys the prompt body can rely on.

## Control and Data Flow

1. `resolveWorkflowPath()` chooses an explicit workflow path or defaults to `WORKFLOW.md` in the current working directory.
2. `loadProjectEnv()` loads `.env` and `.env.local` from the workflow directory, preserving any non-empty shell environment overrides.
3. `loadWorkflow()` reads the selected workflow file.
4. `parseWorkflow()` splits YAML front matter from the Markdown prompt body when the file starts with `---`.
5. `resolveEffectiveConfig()` converts the front matter into typed runtime config.
6. `renderIssuePrompt()` uses strict Liquid rendering to inject normalized issue data and the retry `attempt`.
7. After the first turn, `buildContinuationPrompt()` takes over instead of re-rendering the full workflow body.

Current front matter sections used by the implementation:

| Section | Purpose |
| --- | --- |
| `tracker` | ClickUp endpoint, auth, workspace, scope filters, and active/terminal states |
| `polling` | Poll cadence |
| `workspace` | Root directory for per-task workspaces |
| `hooks` | Shell hooks around workspace create/run/remove lifecycle |
| `agent` | Concurrency, retry backoff, and max-turn controls |
| `codex` | Codex command and sandbox/timeout settings |
| `server` | Optional local HTTP server port |

Environment precedence:

1. Existing shell env
2. `.env.local`
3. `.env`

The code achieves that by loading file values and only applying them when the target key is absent or blank in the provided environment object.

Template variables available to the prompt body:

| Variable | Meaning |
| --- | --- |
| `issue.id` | Raw ClickUp task ID |
| `issue.clickup_task_id` | Same raw ClickUp task ID |
| `issue.identifier` | Symphony issue identifier, such as `CU-123` |
| `issue.title` | Task title |
| `issue.description` | Task description or `null` |
| `issue.priority` | Normalized integer priority or `null` |
| `issue.state` | Current ClickUp status |
| `issue.branch_name` | Currently always `null` in this implementation |
| `issue.url` | Task URL |
| `issue.labels` | Lowercased ClickUp tag names |
| `issue.blocked_by` | Normalized blocker list |
| `issue.created_at` | ISO timestamp or `null` |
| `issue.updated_at` | ISO timestamp or `null` |
| `attempt` | `null` on first attempt, then retry/continuation number |

Current checked-in workflow artifacts:

- `WORKFLOW-EXAMPLE.md` is the documented template intended for copying into a local `WORKFLOW.md`.
- `WORKFLOW.md` in this checkout is a real configured workflow and should be treated as local runtime state rather than a generic example.
- `.env.example` documents the minimum env keys expected by the setup path in `README.md`.

## Important Exports and Classes

| Path | Export or class | Notes |
| --- | --- | --- |
| `src/workflow.ts` | `resolveWorkflowPath()`, `loadWorkflow()`, `parseWorkflow()`, `watchWorkflow()` | Workflow discovery, parsing, and live reload |
| `src/env.ts` | `loadProjectEnv()`, `parseEnvFile()` | Env file loading and syntax parsing |
| `src/config.ts` | `resolveEffectiveConfig()` | Front matter to typed runtime config |
| `src/prompt.ts` | `renderIssuePrompt()`, `buildContinuationPrompt()`, `prependEnvironmentContext()` | Prompt creation rules |

## Inputs and Outputs
- Inputs:
  - `WORKFLOW.md`
  - `.env`
  - `.env.local`
  - normalized `Issue` data
- Outputs:
  - `WorkflowDefinition`
  - `EffectiveConfig`
  - first-turn prompt text
  - continuation prompt text

## Failure Modes
- Missing workflow files raise `missing_workflow_file`.
- Malformed env assignments raise `invalid_env_file`.
- Invalid YAML front matter raises `workflow_parse_error`.
- Non-map YAML front matter raises `workflow_front_matter_not_a_map`.
- Missing ClickUp auth, missing workspace IDs, or missing scope filters cause config resolution to fail before dispatch.
- Strict Liquid rendering raises `template_render_error` when the template references missing data or invalid filters.

## Related Tests
- `tests/workflow.test.ts`
- `tests/env.test.ts`
- `tests/config.test.ts`
- `tests/prompt.test.ts`

## Related Docs
- [Bootstrap and Config](../modules/bootstrap-and-config.md)
- [Orchestration and Workspaces](../modules/orchestration-and-workspaces.md)
- [Codex Integration](../modules/codex-integration.md)
- [System Overview](../architecture/system-overview.md)
