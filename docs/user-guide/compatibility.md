# Compatibility

This page lists the runtime and integration assumptions for Symphony ClickUp.

## Runtime Matrix

| Area | Supported or expected value | Notes |
| --- | --- | --- |
| Node.js | 20 or newer | `package.json` declares `>=20`. Development currently runs on modern Node 20+ and 22.x. |
| npm | Current npm bundled with supported Node versions | If optional native dependencies are missing, rerun `npm install`. |
| TypeScript | Project-managed through `devDependencies` | Use the checked-in `package-lock.json` for repeatable installs. |
| ClickUp API | ClickUp API v2 | Default endpoint is `https://api.clickup.com/api/v2`. |
| ClickUp auth | API token via `CLICKUP_API_TOKEN` | Required for real task polling and task mutations. |
| Codex CLI | A CLI build that supports `codex app-server` | The command must work in the same shell environment Symphony uses. |
| Codex app-server | Compatible with Symphony's JSON-RPC-like session, turn, and dynamic-tool flow | Keep `codex.command`, `codex.model`, and `codex.reasoning_effort` in `WORKFLOW.md` aligned with your installed Codex version. |
| Git | Required | Used by typical workspace hooks and by agent workflows that create branches or PRs. |
| GitHub CLI | Optional | Useful when your workflow prompt asks Codex to create or merge GitHub PRs. The active `gh` account must be able to access the workspace repository for PR operations. |
| Playwright Chromium | Optional | Required only for the opt-in screenshot capture tool and its gated smoke test. |

## Install Notes

Install project dependencies with:

```bash
npm install
```

If you enable screenshot capture, also install Chromium:

```bash
npx playwright install chromium
```

If tests or runtime commands fail because an optional native package is missing, rerun:

```bash
npm install
```

This can happen with npm optional dependencies on some platforms.

## Integration Notes

Symphony expects at least one ClickUp scope filter in `WORKFLOW.md`: `list_ids`, `space_ids`, or `folder_ids`.

The local dashboard binds to `127.0.0.1`. It is meant for local inspection, not public hosting.

The screenshot tool accepts only local review URLs: `localhost`, `127.0.0.1`, `[::1]`, or workspace-local `file://` URLs.
