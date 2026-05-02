# Configuration Guide

All runtime config lives in the YAML front matter of `WORKFLOW.md`. The Markdown body of that same file becomes the prompt template sent to Codex for each ClickUp task.

## Environment Files

Symphony loads environment files from the same directory as the workflow file:

1. `.env`
2. `.env.local`
3. existing shell environment variables

Precedence:

- Shell environment variables win over everything else.
- `.env.local` overrides `.env`.

Typical local values:

```dotenv
CLICKUP_API_TOKEN=your-clickup-api-token
SYMPHONY_REPO_URL=https://github.com/your-org/your-repo.git
LOG_LEVEL=info
```

`CLICKUP_API_TOKEN` is required for real ClickUp access. `SYMPHONY_REPO_URL` is required only if your workflow hook uses it.

## `tracker`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `tracker.kind` | Yes | none | Must be `clickup` |
| `tracker.endpoint` | No | `https://api.clickup.com/api/v2` | Base ClickUp API URL |
| `tracker.api_key` | Yes | `$CLICKUP_API_TOKEN` | Can be a literal string or env reference |
| `tracker.workspace_id` | Yes | none | ClickUp Workspace/team ID |
| `tracker.space_ids` | No | empty | Optional ClickUp Space filters |
| `tracker.folder_ids` | No | empty | Optional ClickUp Folder filters |
| `tracker.list_ids` | No | empty | Optional ClickUp List filters |
| `tracker.active_states` | No | `Todo`, `In Progress` | Statuses Symphony should work on |
| `tracker.terminal_states` | No | `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done` | Statuses that stop work and trigger cleanup |

You must provide at least one scope filter: `space_ids`, `folder_ids`, or `list_ids`. State matching is case-insensitive.

## `polling`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `polling.interval_ms` | No | `30000` | How often Symphony polls ClickUp |

## `workspace`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `workspace.root` | No | system temp directory + `symphony_workspaces` | Parent folder for per-task workspaces |

Path behavior:

- `~` expands to your home directory.
- `$VAR` reads from the environment.
- relative paths are resolved from the current working directory.

## `hooks`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `hooks.after_create` | No | none | Runs once when a new workspace is created |
| `hooks.before_run` | No | none | Runs before every attempt |
| `hooks.after_run` | No | none | Runs after every attempt |
| `hooks.before_remove` | No | none | Runs before a workspace is deleted |
| `hooks.timeout_ms` | No | `60000` | Timeout for all hooks |

Hook behavior:

- `after_create` failure is fatal and the new workspace is removed.
- `before_run` failure is fatal for that attempt.
- `after_run` failure is logged but does not fail the run.
- `before_remove` failure is logged but cleanup continues.

Hooks run in your login shell, using `$SHELL` and falling back to `bash`.

## `agent`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `agent.max_concurrent_agents` | No | `10` | Global task concurrency |
| `agent.max_concurrent_agents_by_state` | No | `{}` | Optional per-status concurrency overrides |
| `agent.max_retry_backoff_ms` | No | `300000` | Maximum retry backoff |
| `agent.max_turns` | No | `20` | Maximum Codex turns per dispatch |

Retry behavior:

- first retry waits about 10 seconds
- later retries back off exponentially until `max_retry_backoff_ms`

## `codex`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `codex.command` | No | `codex app-server` | Command Symphony launches for each workspace |
| `codex.model` | No | unset | Optional app-server model override passed on `thread/start` and `turn/start` |
| `codex.reasoning_effort` | No | unset | Optional turn effort override passed as `effort` on `turn/start` |
| `codex.personality` | No | unset | Optional Codex personality override |
| `codex.service_name` | No | unset | Optional service label passed on `thread/start` |
| `codex.approval_policy` | No | `never` | Passed through to Codex |
| `codex.thread_sandbox` | No | `workspace-write` | Passed through to Codex when the thread starts |
| `codex.turn_sandbox_policy` | No | `{ type: "workspace-write" }` | Passed through for each turn |
| `codex.turn_timeout_ms` | No | `3600000` | Maximum time for a single turn |
| `codex.read_timeout_ms` | No | `5000` | RPC request/response timeout |
| `codex.stall_timeout_ms` | No | `300000` | Cancels a run if no Codex event is seen within this window |

Example:

```yaml
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  model: gpt-5.3-codex
  reasoning_effort: xhigh
  personality: pragmatic
  service_name: symphony
```

Prefer keeping model and effort settings in explicit workflow keys unless you have a shell-specific reason to inline them into `codex.command`.

## `screenshots`

Review screenshots are opt-in. When enabled, Symphony advertises a first-party Codex tool that captures a local browser page with Playwright, uploads the PNG to the ClickUp task as an attachment, and adds a `## Codex Screenshot` comment.

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `screenshots.enabled` | No | `false` | Enables the screenshot dynamic tool |
| `screenshots.output_dir` | No | `.symphony-artifacts/screenshots` | Relative paths resolve under `workspace.root`, not inside a task repo |
| `screenshots.max_files_per_attempt` | No | `8` | Maximum screenshots one Codex attempt may attach |
| `screenshots.max_file_bytes` | No | `10485760` | Maximum PNG size before upload |

Example:

```yaml
screenshots:
  enabled: true
  output_dir: .symphony-artifacts/screenshots
  max_files_per_attempt: 8
  max_file_bytes: 10485760
```

The screenshot tool only accepts local review URLs: `localhost`, `127.0.0.1`, `[::1]`, or `file://` paths inside the active workspace.

## `server`

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `server.port` | No | disabled | Starts the local dashboard/API on this port |

You can also set the port at runtime with `--port`. The CLI value overrides `server.port`.

## Prompt Template Variables

The body of `WORKFLOW.md` is rendered with Liquid templates.

Available values include:

| Variable | Meaning |
| --- | --- |
| `issue.id` | Raw ClickUp task ID |
| `issue.clickup_task_id` | Same as `issue.id` |
| `issue.identifier` | Symphony issue identifier, such as `CU-123` |
| `issue.title` | Task title |
| `issue.description` | Task description |
| `issue.priority` | Normalized priority if available |
| `issue.state` | Current ClickUp status |
| `issue.url` | Task URL |
| `issue.labels` | Lowercased ClickUp tags |
| `issue.blocked_by` | Blocker list with `id`, `identifier`, and `state` |
| `issue.created_at` | Creation time |
| `issue.updated_at` | Update time |
| `attempt` | `null` on first dispatch, then a retry/continuation number |

Example:

```md
You are working on ClickUp task {{ issue.identifier }}.

Title: {{ issue.title }}
Status: {{ issue.state }}

{% if attempt %}
This is retry attempt #{{ attempt }}.
{% endif %}
```

If the prompt body is empty, Symphony falls back to:

```text
You are working on an issue from ClickUp.
```

## Built-In ClickUp Tools for Codex

Symphony can advertise first-party ClickUp tools to Codex during a run.

These tools are:

- `clickup_get_task`
- `clickup_update_task`
- `clickup_get_task_comments`
- `clickup_create_task_comment`
- `clickup_capture_review_screenshot` when `screenshots.enabled` is true

This is useful because your workflow prompt can instruct Codex to:

- read the latest task details
- add worklog comments
- update task status
- update the task description
- attach browser screenshots for local visual review
