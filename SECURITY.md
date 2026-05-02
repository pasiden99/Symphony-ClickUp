# Security Policy

Symphony ClickUp runs local automation that can read ClickUp tasks, create workspaces, run shell hooks, launch Codex, and update ClickUp. Treat workflow files, environment files, and task content as security-sensitive inputs.

## Supported Versions

Security fixes are expected to target the latest released version on the default branch. Older versions may receive fixes when the change is low risk and practical to backport.

## Reporting a Vulnerability

Please do not disclose vulnerabilities publicly before maintainers have had a chance to investigate.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled, open a minimal public issue that says you have a security report to share, but do not include secrets, exploit details, private URLs, tokens, task data, or screenshots.

Useful reports include:

- affected version or commit
- operating system and Node.js version
- whether the issue requires a malicious workflow, malicious ClickUp task, compromised repository, or normal operator action
- concise reproduction steps using redacted values
- expected impact

## Secret Handling

Do not commit:

- `.env`, `.env.local`, or other local environment files
- ClickUp API tokens
- Codex credentials or session data
- private repository URLs when they should not be public
- screenshots or logs that contain private task or repository data

`CLICKUP_API_TOKEN` should be stored in local environment files or the shell environment. Prefer least-privilege ClickUp tokens when possible.

## Workflow and Hook Safety

`WORKFLOW.md` controls how Symphony runs. Its hook fields execute shell commands on the local machine, and its prompt body controls what Codex is asked to do.

Review workflow files before running them, especially:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`
- `codex.command`
- `codex.turn_sandbox_policy`

Only run workflows from people and repositories you trust. Avoid broad writable roots unless the workflow needs them.

## Runtime Exposure

The dashboard and API bind to `127.0.0.1` only. Do not proxy or expose the local dashboard to untrusted networks unless you add your own authentication and access controls.

When screenshot capture is enabled, Symphony only accepts local review URLs. Review screenshots before sharing them outside trusted channels.

## Dynamic Tool Safety

Symphony can expose first-party ClickUp tools to Codex during a run. Workflow prompts should be explicit about allowed task reads, comments, status updates, and screenshot capture.

When changing dynamic tools, validate:

- task ID resolution
- argument validation
- ClickUp API paths and methods
- screenshot file limits
- failure behavior for unsupported tool calls

The safest failure mode is a clear tool error without hanging the Codex session or mutating the wrong task.
