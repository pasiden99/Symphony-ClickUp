import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveEffectiveConfig } from "../src/config.js";
import { SymphonyError } from "../src/errors.js";
import type { WorkflowDefinition } from "../src/types.js";

const baseWorkflow: WorkflowDefinition = {
  filePath: "/tmp/WORKFLOW.md",
  loadedAt: new Date().toISOString(),
  promptTemplate: "Task {{ issue.identifier }}",
  config: {
    tracker: {
      kind: "clickup",
      api_key: "$CLICKUP_API_TOKEN",
      workspace_id: "team-1",
      list_ids: ["list-1"]
    }
  }
};

describe("config resolution", () => {
  test("resolves env-backed token and applies defaults", () => {
    const config = resolveEffectiveConfig(baseWorkflow, {
      cwd: "/tmp/repo",
      env: {
        CLICKUP_API_TOKEN: "token-123"
      }
    });

    expect(config.tracker.apiKey).toBe("token-123");
    expect(config.tracker.endpoint).toBe("https://api.clickup.com/api/v2");
    expect(config.agent.maxTurns).toBe(20);
    expect(config.workspace.root).toContain("symphony_workspaces");
    expect(config.screenshots).toMatchObject({
      enabled: false,
      maxFilesPerAttempt: 8,
      maxFileBytes: 10 * 1024 * 1024
    });
    expect(config.screenshots.outputDir).toBe(
      path.join(config.workspace.root, ".symphony-artifacts/screenshots")
    );
  });

  test("requires at least one clickup scope filter", () => {
    expect(() =>
      resolveEffectiveConfig(
        {
          ...baseWorkflow,
          config: {
            tracker: {
              kind: "clickup",
              api_key: "literal",
              workspace_id: "team-1"
            }
          }
        },
        {
          cwd: "/tmp/repo",
          env: {}
        }
      )
    ).toThrowError(SymphonyError);
  });

  test("expands env-backed workspace root paths", () => {
    const config = resolveEffectiveConfig(
      {
        ...baseWorkflow,
        config: {
          ...baseWorkflow.config,
          workspace: {
            root: "$WORKSPACE_ROOT"
          }
        }
      },
      {
        cwd: "/tmp/repo",
        env: {
          CLICKUP_API_TOKEN: "token-123",
          WORKSPACE_ROOT: `${os.tmpdir()}/custom-workspaces`
        }
      }
    );

    expect(config.workspace.root).toContain("custom-workspaces");
  });

  test("resolves optional codex model overrides", () => {
    const config = resolveEffectiveConfig(
      {
        ...baseWorkflow,
        config: {
          ...baseWorkflow.config,
          codex: {
            command: "codex app-server",
            model: "gpt-5.3-codex",
            reasoning_effort: "xhigh",
            personality: "pragmatic",
            service_name: "symphony-tests"
          }
        }
      },
      {
        cwd: "/tmp/repo",
        env: {
          CLICKUP_API_TOKEN: "token-123"
        }
      }
    );

    expect(config.codex.model).toBe("gpt-5.3-codex");
    expect(config.codex.reasoningEffort).toBe("xhigh");
    expect(config.codex.personality).toBe("pragmatic");
    expect(config.codex.serviceName).toBe("symphony-tests");
  });

  test("resolves opt-in screenshot config under the workspace root", () => {
    const config = resolveEffectiveConfig(
      {
        ...baseWorkflow,
        config: {
          ...baseWorkflow.config,
          workspace: {
            root: "/tmp/symphony-workspaces"
          },
          screenshots: {
            enabled: true,
            output_dir: ".review/screens",
            max_files_per_attempt: 3,
            max_file_bytes: 4096
          }
        }
      },
      {
        cwd: "/tmp/repo",
        env: {
          CLICKUP_API_TOKEN: "token-123"
        }
      }
    );

    expect(config.screenshots).toEqual({
      enabled: true,
      outputDir: "/tmp/symphony-workspaces/.review/screens",
      maxFilesPerAttempt: 3,
      maxFileBytes: 4096
    });
  });
});
