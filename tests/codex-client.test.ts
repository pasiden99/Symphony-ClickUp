import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CodexAppServerClient } from "../src/codex/client.js";
import { createLogger } from "../src/logging.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

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

  test("fails when the server requests user input", async () => {
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
      onEvent: () => undefined
    });

    await expect(
      session.runTurn({
        prompt: "NEEDS_INPUT",
        title: "ENG-2: Needs input"
      })
    ).rejects.toMatchObject({
      code: "turn_input_required"
    });

    await session.close();
  });
});
