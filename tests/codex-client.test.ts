import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CodexAppServerClient, materializeTurnSandboxPolicy } from "../src/codex/client.js";
import type { DynamicToolHandler } from "../src/codex/dynamic-tools.js";
import { createLogger } from "../src/logging.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");
const legacyFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-app-server-legacy-tools.mjs"
);

describe("CodexAppServerClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("completes a turn and emits session events", async () => {
    const events: string[] = [];
    const client = new CodexAppServerClient(
      {
        command: `${process.execPath} ${fixturePath}`,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspace-write" },
        turnTimeoutMs: 5_000,
        readTimeoutMs: 2_000,
        stallTimeoutMs: 10_000
      },
      createLogger({ enabled: false })
    );

    const session = await client.startSession({
      workspacePath: process.cwd(),
      onEvent: (event) => {
        events.push(event.event);
      }
    });

    const result = await session.runTurn({
      prompt: "Finish the task",
      title: "ENG-1: Finish the task"
    });

    await session.close();

    expect(result.status).toBe("completed");
    expect(result.turnId).toBe("turn-1");
    expect(events).toContain("session_started");
    expect(events).toContain("thread_tokenUsage_updated");
    expect(events).toContain("turn_completed");
  });

  test("returns a failed turn result when the server requests user input", async () => {
    const events: string[] = [];
    const client = new CodexAppServerClient(
      {
        command: `${process.execPath} ${fixturePath}`,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspace-write" },
        turnTimeoutMs: 5_000,
        readTimeoutMs: 2_000,
        stallTimeoutMs: 10_000
      },
      createLogger({ enabled: false })
    );

    const session = await client.startSession({
      workspacePath: process.cwd(),
      onEvent: (event) => {
        events.push(event.event);
      }
    });

    const result = await session.runTurn({
      prompt: "NEEDS_INPUT",
      title: "ENG-2: Needs input"
    });

    await session.close();

    expect(result).toEqual({
      status: "failed",
      turnId: "turn-1",
      error: "Interactive input required"
    });
    expect(events).toContain("turn_input_required");
    expect(events).toContain("turn_failed");
  });

  test("advertises and handles supported dynamic tool calls", async () => {
    const toolHandler: DynamicToolHandler = {
      listTools: () => [
        {
          name: "clickup_get_task",
          description: "Get a ClickUp task",
          inputSchema: {
            type: "object",
            required: ["taskId"],
            properties: {
              taskId: { type: "string" }
            }
          }
        }
      ],
      callTool: vi.fn(async () => ({
        success: true,
        contentItems: [
          {
            type: "inputText" as const,
            text: JSON.stringify({ id: "123", status: "Todo" })
          }
        ]
      }))
    };

    const client = new CodexAppServerClient(
      {
        command: `${process.execPath} ${fixturePath}`,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspace-write" },
        turnTimeoutMs: 5_000,
        readTimeoutMs: 2_000,
        stallTimeoutMs: 10_000
      },
      createLogger({ enabled: false }),
      toolHandler
    );

    const session = await client.startSession({
      workspacePath: process.cwd(),
      onEvent: () => undefined
    });

    const result = await session.runTurn({
      prompt: "USE_TOOL",
      title: "ENG-3: Uses tool"
    });

    await session.close();

    expect(result.status).toBe("completed");
    expect(toolHandler.callTool).toHaveBeenCalledWith("clickup_get_task", {
      taskId: "123"
    });
  });

  test("falls back to legacy tools field when dynamicTools is rejected", async () => {
    const client = new CodexAppServerClient(
      {
        command: `${process.execPath} ${legacyFixturePath}`,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspace-write" },
        turnTimeoutMs: 5_000,
        readTimeoutMs: 2_000,
        stallTimeoutMs: 10_000
      },
      createLogger({ enabled: false }),
      {
        listTools: () => [
          {
            name: "clickup_get_task",
            description: "Get a ClickUp task",
            inputSchema: {
              type: "object",
              required: ["taskId"],
              properties: {
                taskId: { type: "string" }
              }
            }
          }
        ],
        callTool: vi.fn(async () => null)
      }
    );

    const session = await client.startSession({
      workspacePath: process.cwd(),
      onEvent: () => undefined
    });

    const result = await session.runTurn({
      prompt: "Finish the task",
      title: "ENG-4: Fallback tools"
    });

    await session.close();

    expect(result.status).toBe("completed");
    expect(result.turnId).toBe("turn-legacy");
  });

  test("materializes workspaceWrite sandbox policy with git metadata writes and network access", () => {
    const policy = materializeTurnSandboxPolicy(
      {
        type: "workspaceWrite",
        writable_roots: [".", ".git"],
        read_only_access: {
          type: "restricted",
          include_platform_defaults: false,
          readable_roots: [".git"]
        }
      },
      "/tmp/workspaces/CU-0"
    );

    expect(policy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/workspaces/CU-0", "/tmp/workspaces/CU-0/.git"],
      readOnlyAccess: {
        type: "restricted",
        includePlatformDefaults: false,
        readableRoots: ["/tmp/workspaces/CU-0/.git"]
      },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    });
  });
});
