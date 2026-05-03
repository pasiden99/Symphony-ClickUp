---
# Copy this file to `WORKFLOW.md`, then replace the placeholder ClickUp values below.
tracker:
  kind: clickup
  endpoint: https://api.clickup.com/api/v2
  api_key: $CLICKUP_API_TOKEN
  workspace_id: "REPLACE_WITH_CLICKUP_WORKSPACE_ID" # Use the ClickUp Workspace/team ID from API v2, not a Space or List ID.
  list_ids:
    - "REPLACE_WITH_CLICKUP_LIST_ID" # Add one or more ClickUp List IDs that Symphony should poll.
  # Update these only if your ClickUp workflow uses different status names.
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 5000
workspace:
  root: ~/code/symphony-workspaces
hooks:
  after_create: |
    : "${SYMPHONY_REPO_URL:?Set SYMPHONY_REPO_URL to the repository clone URL before starting Symphony.}"
    git clone --depth 1 "$SYMPHONY_REPO_URL" .
    if [ -f package-lock.json ]; then
      npm ci
    fi
agent:
  max_concurrent_agents: 10
  max_turns: 8
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  model: gpt-5.3-codex
  reasoning_effort: xhigh
  personality: pragmatic
  service_name: symphony
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writable_roots:
      - .
      - .git
    read_only_access:
      type: fullAccess
    network_access: true
    exclude_tmpdir_env_var: false
    exclude_slash_tmp: false
screenshots:
  enabled: false
  output_dir: .symphony-artifacts/screenshots
  max_files_per_attempt: 8
  max_file_bytes: 10485760
audit:
  enabled: true
  output_dir: .symphony-artifacts/audit
  max_recent_events: 500
  max_event_bytes: 16384
  retention_days: 14
  include_raw_codex_events: false
server:
  port: 3000
---

You are working on ClickUp task `{{ issue.identifier }}`.

Task context:
- Raw ClickUp task ID: `{{ issue.clickup_task_id }}`
- Title: {{ issue.title }}
- Status: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

Description:
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}

{% if attempt %}
Retry attempt #{{ attempt }}: resume from workspace state and avoid repeating completed investigation unless new evidence requires it.
{% endif %}

## Operating Rules

- Run unattended end to end in the provided workspace only.
- Trust the provided task context unless it is missing, stale, or contradicted by workspace/task evidence; use Symphony's ClickUp tools only when fresh task data, comments, status changes, worklogs, description updates, or screenshots are needed.
- Stop only for true external blockers such as missing auth, permissions, secrets, repository bootstrap inputs, or required tooling.
- Final message: completed actions, validation run, and blockers only.

## Status Route

- `Backlog`: do not modify; stop.
- `Todo`: move to `In Progress`, then execute.
- `In Progress`: execute.
- `Human Review`: do not code unless moved to `Rework` or `Merging`.
- `Merging`: verify approval/checks, merge if permitted, delete the merged remote PR branch when possible, then move to `Done`; if blocked by conflicts or permissions, comment and move to `Rework` when appropriate.
- `Rework`: re-read task, comments, and review feedback; plan fresh changes and return to `Human Review` only after all feedback is addressed.
- Terminal statuses (`Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`): stop.

## Execution

1. Check repo state (`branch`, `git status`, `HEAD`), existing PR state, and whether prior branch work is reusable; if a prior branch PR is closed or merged, create a fresh branch from `origin/main`.
2. Read ClickUp comments or task details only when needed for handoff notes, review feedback, stale context, or acceptance criteria not present above.
3. Add concise `## Codex Worklog` comments at kickoff, meaningful milestones, blockers, and completion. Include current state, branch, plan, acceptance criteria, validation plan, risks, and compact environment stamp when useful.
4. Reproduce or inspect the issue signal before editing, sync with latest `origin/main`, implement only in scope, and keep unrelated improvements out of the change.
5. Run task-provided `Validation`, `Test Plan`, or `Testing` steps exactly when present; otherwise run targeted proof for the changed behavior. Revert temporary proof edits.
6. If screenshots are enabled and the change is visually reviewable, capture local review URLs only (`localhost`, `127.0.0.1`, `[::1]`, or workspace-local `file://`) and let the screenshot tool attach the PNG and comment. If not applicable, say why in the final worklog.
7. Before declaring ready, rerun required validation, push the branch, create or update the PR, and make the PR URL visible from the task context/comment.
8. Move to `Human Review` only after the PR URL is visible. If PR creation fails, try available GitHub fallbacks first, including account/repo-access checks or switching to another logged-in account with access; then record a blocker instead of moving to `Human Review` if no PR path works.

If a required ClickUp tool call fails, do not guess at task metadata. Leave the repo clean when possible, record the blocker if possible, and report it.
