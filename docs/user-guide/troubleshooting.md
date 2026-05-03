# Troubleshooting

## Symphony Starts But Does Not Pick Up Any Tasks

Check:

- the ClickUp token is valid
- `tracker.workspace_id` is correct
- at least one of `list_ids`, `space_ids`, or `folder_ids` is set
- the task status exactly matches one of your `active_states`
- the task is not blocked by a non-terminal dependency if it is in `Todo`

## The Workspace Folder Is Empty

Symphony only creates the directory. Your hook must populate it.

If you expect a cloned repo, check `hooks.after_create`.

## The Dashboard Does Not Open

Check:

- `server.port` is set in `WORKFLOW.md`, or you started Symphony with `--port`
- the port is not already in use
- you are opening `127.0.0.1`, not a remote host

## Tasks Keep Retrying

That usually means one of these:

- Codex failed to complete a turn
- a hook failed
- ClickUp polling failed
- the run stalled and exceeded `codex.stall_timeout_ms`

Set `LOG_LEVEL=debug` for more detail.

## Codex Exits Immediately With a Missing Optional Dependency

If the retry error mentions a missing package such as `@openai/codex-darwin-x64` or `@openai/codex-darwin-arm64`, reinstall Codex in the same Node environment Symphony uses:

```bash
nvm use <your-node-version>
npm uninstall -g @openai/codex
npm install -g @openai/codex@latest --include=optional
hash -r
codex --version
```

If you do not use `nvm`, activate whatever Node installation provides `codex` first. If `codex --version` still fails, check whether npm is omitting optional dependencies with `npm config get omit`.

## Vitest Fails With a Missing Rollup Optional Dependency

If `npm test` fails with a missing package such as `@rollup/rollup-darwin-arm64`, refresh project dependencies:

```bash
npm install
```

This is usually an npm optional-dependency install issue.

## A Task Stopped Retrying After Asking For Input

If Codex requests interactive input during an unattended run, Symphony treats the issue as blocked instead of retrying the same attempt immediately.

Symphony will try the task again only after the ClickUp task changes, such as a status update, description edit, or comment that updates the task timestamp.

## Codex Can Work Locally But Cannot Handle GitHub PR Steps

Symphony checks for GitHub CLI availability, authentication, and active-account access to the workspace repository. If `gh` is missing, unauthenticated, or authenticated as an account that cannot see the repository, PR-related workflow steps may stop early.

Run these commands inside the task workspace to verify the same inputs Symphony checks:

```bash
gh auth status
gh repo view "$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\\.git$##')" --json nameWithOwner
```

If multiple GitHub accounts are logged in, switch the active account to one with repository access before retrying the ClickUp task.

## I Changed `WORKFLOW.md` But the Dashboard Port Did Not Change

Workflow content is reloaded automatically, but the HTTP server does not move to a new port until Symphony is restarted.
