import { describe, expect, test } from "vitest";

import { ClickUpDynamicToolHandler } from "../src/codex/dynamic-tools.js";
import { createLogger } from "../src/logging.js";

describe("ClickUpDynamicToolHandler", () => {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
