import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { AgentRunner, collectEnvironmentPreflight, parseGithubRepository } from "../src/agent-runner.js";
import { createLogger } from "../src/logging.js";
import type { EffectiveConfig, Issue, TrackerClient } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

describe("AgentRunner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("uses refreshed tracker config for runs after updateConfig", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-runner-"));
    tempDirs.push(root);

    const trackerCalls: string[] = [];
    const logger = createLogger({ enabled: false });
    const initialConfig = baseConfig(root, "team-1");
    const runner = new AgentRunner(
      initialConfig,
      (config): TrackerClient => ({
        fetchCandidateIssues: async () => [],
        fetchIssuesByStates: async () => [],
        fetchIssueStatesByIds: async () => {
          trackerCalls.push(config.tracker.workspaceId);
          return [baseIssue()];
        }
      }),
      new WorkspaceManager(initialConfig, logger),
      logger
    );

    const firstResult = await runner.runAttempt({
      issue: baseIssue(),
      attempt: null,
      workflowPromptTemplate: "Handle {{ issue.identifier }}",
      onEvent: () => undefined
    });

    expect(firstResult.status).toBe("succeeded");
    expect(trackerCalls).toEqual(["team-1"]);

    runner.updateConfig(baseConfig(root, "team-2"));
    const secondResult = await runner.runAttempt({
      issue: baseIssue(),
      attempt: null,
      workflowPromptTemplate: "Handle {{ issue.identifier }}",
      onEvent: () => undefined
    });

    expect(secondResult.status).toBe("succeeded");
    expect(trackerCalls).toEqual(["team-1", "team-2"]);
  });

  test("environment preflight verifies active GitHub CLI repo access", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const preflight = await collectEnvironmentPreflight("/tmp/workspace", async (command, args, cwd) => {
      calls.push({ command, args, cwd });

      if (command === "gh" && args.join(" ") === "auth status") {
        return {
          code: 0,
          stdout: "github.com\n  ✓ Logged in to github.com account wrong-user (keyring)\n",
          stderr: ""
        };
      }

      if (command === "git" && args.join(" ") === "remote get-url origin") {
        return {
          code: 0,
          stdout: "https://github.com/acme/private-repo.git\n",
          stderr: ""
        };
      }

      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return {
          code: 1,
          stdout: "",
          stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/private-repo'. (repository)"
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "gh auth status",
      "git remote get-url origin",
      "gh repo view acme/private-repo --json nameWithOwner"
    ]);
    expect(preflight.githubCli.ok).toBe(false);
    expect(preflight.githubCli.summary).toContain("GitHub CLI cannot access repository acme/private-repo");
    expect(preflight.notices).toHaveLength(1);
    expect(preflight.notices[0]).toContain("try available PR fallbacks");
    expect(preflight.notices[0]).toContain("switching to a logged-in account");
    expect(preflight.notices[0]).toContain("block only if no PR path works");
  });

  test("environment preflight stays quiet when GitHub CLI can access the repo", async () => {
    const preflight = await collectEnvironmentPreflight("/tmp/workspace", async (command, args) => {
      if (command === "gh" && args.join(" ") === "auth status") {
        return { code: 0, stdout: "github.com\n  ✓ Logged in\n", stderr: "" };
      }

      if (command === "git" && args.join(" ") === "remote get-url origin") {
        return { code: 0, stdout: "git@github.com:acme/private-repo.git\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: "{\"nameWithOwner\":\"acme/private-repo\"}", stderr: "" };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    expect(preflight.githubCli.ok).toBe(true);
    expect(preflight.githubCli.summary).toContain("repo access are available for acme/private-repo");
    expect(preflight.notices).toEqual([]);
  });

  test("parses common GitHub remote URL formats", () => {
    expect(parseGithubRepository("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseGithubRepository("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseGithubRepository("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseGithubRepository("https://gitlab.com/acme/widgets.git")).toBeNull();
  });
});

function baseIssue(): Issue {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "Implement reload fix",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2025-01-01T00:00:00Z").toISOString()
  };
}

function baseConfig(root: string, workspaceId: string): EffectiveConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    tracker: {
      kind: "clickup",
      endpoint: "https://api.clickup.com/api/v2",
      apiKey: "token",
      workspaceId,
      spaceIds: [],
      folderIds: [],
      listIds: ["list-1"],
      activeStates: ["Todo", "In Progress"],
      activeStateSet: new Set(["todo", "in progress"]),
      terminalStates: ["Done"],
      terminalStateSet: new Set(["done"])
    },
    polling: {
      intervalMs: 1000
    },
    workspace: {
      root
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1000
    },
    agent: {
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {},
      maxRetryBackoffMs: 30_000,
      maxTurns: 1
    },
    codex: {
      command: `${process.execPath} ${fixturePath}`,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspace-write" },
      turnTimeoutMs: 10_000,
      readTimeoutMs: 2_000,
      stallTimeoutMs: 10_000
    },
    screenshots: {
      enabled: false,
      outputDir: path.join(root, ".symphony-artifacts/screenshots"),
      maxFilesPerAttempt: 8,
      maxFileBytes: 10 * 1024 * 1024
    },
    audit: {
      enabled: true,
      outputDir: path.join(root, ".symphony-artifacts/audit"),
      maxRecentEvents: 500,
      maxEventBytes: 16_384,
      retentionDays: 14,
      includeRawCodexEvents: false
    },
    server: {
      port: null
    }
  };
}
