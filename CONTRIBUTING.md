# Contributing

Thanks for taking the time to improve Symphony ClickUp.

This project is a local automation service that can launch Codex against real repositories and mutate ClickUp tasks. Contributions should preserve that operator safety model: keep runtime behavior explicit, test changes that affect orchestration, and document workflow-contract changes clearly.

## Local Setup

Requirements:

- Node.js 20 or newer
- npm
- Git
- A Codex CLI installation that supports `app-server`, if you are testing runtime behavior locally
- A ClickUp API token, if you are testing real ClickUp integration

Install dependencies:

```bash
npm install
```

Build the CLI:

```bash
npm run build
```

Create local runtime config only when you need to run Symphony:

```bash
cp .env.example .env.local
cp WORKFLOW-EXAMPLE.md WORKFLOW.md
```

`WORKFLOW.md`, `.env.local`, `dist/`, and `node_modules/` are local-only and should not be committed.

## Validation

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

For screenshot-tool changes, install Playwright Chromium and run the gated smoke test:

```bash
npx playwright install chromium
RUN_PLAYWRIGHT_SCREENSHOT_TEST=1 npm test -- tests/screenshot-capturer.test.ts
```

If `npm test` fails with a missing Rollup optional native package, refresh dependencies with `npm install`. This is usually an npm optional-dependency install issue rather than a Symphony test failure.

## Pull Requests

Good pull requests include:

- a concise description of what changed and why
- the validation commands you ran
- screenshots or API examples for dashboard/API changes
- documentation updates for behavior, config, or workflow-contract changes
- a changelog entry for user-visible changes

Keep unrelated refactors out of feature or bug-fix PRs. The orchestrator, workspace lifecycle, and Codex transport code are tightly coupled enough that small focused changes are easier to review.

## Documentation Changes

Update docs when changing:

- `WORKFLOW.md` front matter or prompt variables
- ClickUp API behavior or dynamic tools
- Codex app-server request/response behavior
- workspace hooks, cleanup, or safety checks
- dashboard/API routes
- setup, compatibility, or troubleshooting guidance

Use these docs as the main homes:

- `README.md` for overview and quick start
- `docs/user-guide/` for operator-facing setup, config, operations, and troubleshooting
- `docs/reference/workflow-contract.md` for the workflow contract
- `docs/modules/` and `docs/architecture/` for implementation details
- `docs/testing/test-map.md` for test coverage and gaps

## Security-Sensitive Changes

Be careful with changes involving:

- ClickUp tokens or task mutations
- shell hooks
- workspace path handling
- sandbox policies
- dynamic tools exposed to Codex
- network or filesystem access

Do not commit secrets, local workflow files, task data, screenshots with private information, or generated workspace contents. See `SECURITY.md` for reporting and handling guidance.
