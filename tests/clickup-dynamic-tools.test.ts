import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ClickUpDynamicToolHandler } from "../src/codex/dynamic-tools.js";
import type { ScreenshotCapturer } from "../src/codex/screenshots.js";
import { createLogger } from "../src/logging.js";

describe("ClickUpDynamicToolHandler", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("updates a task and returns refreshed JSON", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null
      });

      if (url.includes("/task/1") && (init?.method ?? "GET") === "PUT") {
        return jsonResponse({ ok: true });
      }

      if (url.includes("/task/1") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          id: "1",
          name: "Implement runner",
          status: { status: "In Progress" }
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const handler = new ClickUpDynamicToolHandler(baseConfig(), createLogger({ enabled: false }), fetchMock);
    const result = await handler.callTool("clickup_update_task", {
      taskId: "1",
      status: "In Progress",
      markdownDescription: "## Codex Worklog"
    });

    expect(result).toMatchObject({
      success: true
    });
    expect(requests[0]).toMatchObject({
      url: "https://api.clickup.com/api/v2/task/1",
      method: "PUT",
      body: JSON.stringify({
        status: "In Progress",
        markdown_description: "## Codex Worklog"
      })
    });
    expect(requests[1]).toMatchObject({
      url: "https://api.clickup.com/api/v2/task/1?include_markdown_description=true",
      method: "GET"
    });
  });

  test("creates a task comment", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/task/1/comment") && (init?.method ?? "GET") === "POST") {
        expect(typeof init?.body).toBe("string");
        expect(init?.body).toBe(JSON.stringify({ comment_text: "Started work", notify_all: true }));
        return jsonResponse({
          id: "c1",
          comment_text: "Started work"
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const handler = new ClickUpDynamicToolHandler(baseConfig(), createLogger({ enabled: false }), fetchMock);
    const result = await handler.callTool("clickup_create_task_comment", {
      taskId: "1",
      commentText: "Started work",
      notifyAll: true
    });

    expect(result).toMatchObject({
      success: true
    });
    expect(result?.contentItems[0]?.text).toContain("Started work");
  });

  test("resolves the current Symphony issue identifier to the raw ClickUp task ID", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null
      });

      if (url.includes("/task/868ht62zr") && (init?.method ?? "GET") === "PUT") {
        return jsonResponse({ ok: true });
      }

      if (url.includes("/task/868ht62zr") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          id: "868ht62zr",
          status: { status: "In Progress" }
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const handler = new ClickUpDynamicToolHandler(
      baseConfig(),
      createLogger({ enabled: false }),
      fetchMock,
      30_000,
      {
        currentIssue: {
          id: "868ht62zr",
          identifier: "CU-0"
        }
      }
    );

    const result = await handler.callTool("clickup_update_task", {
      taskId: "CU-0",
      status: "In Progress",
      markdown_description: "## Codex Worklog"
    });

    expect(result).toMatchObject({
      success: true
    });
    expect(requests[0]?.url).toContain("/task/868ht62zr");
    expect(requests[0]?.url).toBe("https://api.clickup.com/api/v2/task/868ht62zr");
    expect(requests[0]?.body).toBe(
      JSON.stringify({
        status: "In Progress",
        markdown_description: "## Codex Worklog"
      })
    );
  });

  test("preserves the configured API base path for task reads", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null
      });

      if (url === "https://api.clickup.com/api/v2/task/868ht62zr?include_markdown_description=true") {
        return jsonResponse({
          id: "868ht62zr",
          name: "Implement runner",
          status: { status: "Todo" }
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const handler = new ClickUpDynamicToolHandler(baseConfig(), createLogger({ enabled: false }), fetchMock);
    const result = await handler.callTool("clickup_get_task", {
      taskId: "868ht62zr"
    });

    expect(result).toMatchObject({
      success: true
    });
    expect(requests[0]).toMatchObject({
      url: "https://api.clickup.com/api/v2/task/868ht62zr?include_markdown_description=true",
      method: "GET"
    });
  });

  test("advertises the screenshot tool only when screenshots are enabled", () => {
    const disabled = new ClickUpDynamicToolHandler(baseConfig(), createLogger({ enabled: false }));
    expect(disabled.listTools().map((tool) => tool.name)).not.toContain("clickup_capture_review_screenshot");

    const enabled = new ClickUpDynamicToolHandler(baseConfig(), createLogger({ enabled: false }), fetch, 30_000, {
      workspacePath: "/tmp/workspace",
      screenshots: screenshotConfig("/tmp/screens")
    });
    expect(enabled.listTools().map((tool) => tool.name)).toContain("clickup_capture_review_screenshot");
  });

  test("captures, uploads, and comments on a review screenshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-screenshot-"));
    tempDirs.push(root);
    const workspacePath = path.join(root, "workspace");
    const outputDir = path.join(root, "screenshots");
    await mkdir(workspacePath, { recursive: true });

    const captureMock = vi.fn<ScreenshotCapturer["capture"]>(async (request) => {
      await writeFile(request.outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body
      });

      if (url === "https://api.clickup.com/api/v2/task/868ht62zr/attachment" && init?.method === "POST") {
        expect(init.headers).toMatchObject({
          Authorization: "token",
          Accept: "application/json"
        });
        expect(init.headers).not.toHaveProperty("Content-Type");
        expect(init.body).toBeInstanceOf(FormData);
        expect((init.body as FormData).get("filename")).toBeTruthy();
        expect((init.body as FormData).get("attachment")).toBeInstanceOf(Blob);
        return jsonResponse({ id: "att-1" });
      }

      if (url === "https://api.clickup.com/api/v2/task/868ht62zr/comment" && init?.method === "POST") {
        expect(typeof init.body).toBe("string");
        expect(init.body).toContain("## Codex Screenshot");
        expect(init.body).toContain("Label: Dashboard after save");
        expect(init.body).toContain("Upload status: attached to this task");
        return jsonResponse({ id: "comment-1" });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const handler = new ClickUpDynamicToolHandler(
      baseConfig(),
      createLogger({ enabled: false }),
      fetchMock,
      30_000,
      {
        currentIssue: {
          id: "868ht62zr",
          identifier: "CU-0"
        },
        workspacePath,
        screenshots: screenshotConfig(outputDir),
        screenshotCapturer: {
          capture: captureMock
        }
      }
    );

    const result = await handler.callTool("clickup_capture_review_screenshot", {
      taskId: "CU-0",
      url: "http://localhost:5173/dashboard",
      label: "Dashboard after save"
    });

    expect(result).toMatchObject({ success: true });
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:5173/dashboard",
        viewport: {
          width: 1440,
          height: 900
        },
        fullPage: true,
        waitMs: 0
      })
    );
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://api.clickup.com/api/v2/task/868ht62zr/attachment",
      "POST https://api.clickup.com/api/v2/task/868ht62zr/comment"
    ]);
    expect(result?.contentItems[0]?.text).toContain("localArtifactPath");
  });

  test("rejects non-local screenshot URLs before capture", async () => {
    const captureMock = vi.fn<ScreenshotCapturer["capture"]>();
    const fetchMock = vi.fn<typeof fetch>();
    const handler = new ClickUpDynamicToolHandler(
      baseConfig(),
      createLogger({ enabled: false }),
      fetchMock,
      30_000,
      {
        workspacePath: "/tmp/workspace",
        screenshots: screenshotConfig("/tmp/screens"),
        screenshotCapturer: {
          capture: captureMock
        }
      }
    );

    const result = await handler.callTool("clickup_capture_review_screenshot", {
      taskId: "1",
      url: "https://example.com",
      label: "External page"
    });

    expect(result).toMatchObject({ success: false });
    expect(result?.contentItems[0]?.text).toContain("Only local review URLs are allowed");
    expect(captureMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects invalid screenshot labels and excessive viewports", async () => {
    const handler = new ClickUpDynamicToolHandler(baseConfig(), createLogger({ enabled: false }), fetch, 30_000, {
      workspacePath: "/tmp/workspace",
      screenshots: screenshotConfig("/tmp/screens"),
      screenshotCapturer: {
        capture: vi.fn<ScreenshotCapturer["capture"]>()
      }
    });

    const missingLabel = await handler.callTool("clickup_capture_review_screenshot", {
      taskId: "1",
      url: "http://127.0.0.1:3000",
      label: "***"
    });
    const hugeViewport = await handler.callTool("clickup_capture_review_screenshot", {
      taskId: "1",
      url: "http://127.0.0.1:3000",
      label: "Dashboard",
      viewportWidth: 9000
    });

    expect(missingLabel).toMatchObject({ success: false });
    expect(missingLabel?.contentItems[0]?.text).toContain("label must contain");
    expect(hugeViewport).toMatchObject({ success: false });
    expect(hugeViewport?.contentItems[0]?.text).toContain("viewportWidth must be between");
  });

  test("rejects screenshot files over the configured size limit before upload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-screenshot-size-"));
    tempDirs.push(root);
    const workspacePath = path.join(root, "workspace");
    const outputDir = path.join(root, "screenshots");
    await mkdir(workspacePath, { recursive: true });
    const fetchMock = vi.fn<typeof fetch>();
    const handler = new ClickUpDynamicToolHandler(
      baseConfig(),
      createLogger({ enabled: false }),
      fetchMock,
      30_000,
      {
        workspacePath,
        screenshots: {
          ...screenshotConfig(outputDir),
          maxFileBytes: 2
        },
        screenshotCapturer: {
          capture: async (request) => {
            await writeFile(request.outputPath, Buffer.from([1, 2, 3]));
          }
        }
      }
    );

    const result = await handler.callTool("clickup_capture_review_screenshot", {
      taskId: "1",
      url: "http://localhost:3000",
      label: "Too large"
    });

    expect(result).toMatchObject({ success: false });
    expect(result?.contentItems[0]?.text).toContain("exceeding max_file_bytes");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function baseConfig() {
  return {
    kind: "clickup" as const,
    endpoint: "https://api.clickup.com/api/v2",
    apiKey: "token",
    workspaceId: "team-1",
    spaceIds: [],
    folderIds: [],
    listIds: ["list-1"],
    activeStates: ["Todo", "In Progress"],
    activeStateSet: new Set(["todo", "in progress"]),
    terminalStates: ["Done"],
    terminalStateSet: new Set(["done"])
  };
}

function screenshotConfig(outputDir: string) {
  return {
    enabled: true,
    outputDir,
    maxFilesPerAttempt: 8,
    maxFileBytes: 10 * 1024 * 1024
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
