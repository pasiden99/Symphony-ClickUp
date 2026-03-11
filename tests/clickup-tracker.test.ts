import { describe, expect, test } from "vitest";

import { ClickUpTrackerClient } from "../src/tracker/clickup.js";
import { createLogger } from "../src/logging.js";

describe("ClickUpTrackerClient", () => {
  test("fetches paginated candidate issues and resolves blockers", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/team/team-1/task") && url.includes("page=0")) {
        return jsonResponse({
          tasks: [
            {
              id: "1",
              custom_id: "ENG-1",
              name: "Implement runner",
              status: { status: "Todo" },
              priority: { priority: "2" },
              tags: [{ name: "Backend" }],
              dependencies: [{ depends_on: "b-1" }],
              date_created: "1700000000000",
              date_updated: "1700001000000",
              url: "https://app.clickup.com/t/1"
            }
          ],
          last_page: false
        });
      }

      if (url.includes("/team/team-1/task") && url.includes("page=1")) {
        return jsonResponse({
          tasks: [
            {
              id: "2",
              name: "Write tests",
              status: { status: "In Progress" },
              tags: [],
              dependencies: [],
              date_created: "1700002000000",
              date_updated: "1700003000000"
            }
          ],
          last_page: true
        });
      }

      if (url.includes("/task/b-1")) {
        return jsonResponse({
          id: "b-1",
          custom_id: "ENG-0",
          name: "Blocked task",
          status: { status: "Done" }
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const client = new ClickUpTrackerClient(
      {
        kind: "clickup",
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
      },
      createLogger({ enabled: false }),
      fetchMock
    );

    const issues = await client.fetchCandidateIssues();

    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      id: "1",
      identifier: "ENG-1",
      state: "Todo",
      labels: ["backend"]
    });
    expect(issues[0]?.blockedBy[0]).toMatchObject({
      id: "b-1",
      identifier: "ENG-0",
      state: "Done"
    });
    expect(issues[1]?.identifier).toBe("CU-2");
    expect(calls[0]).toContain("/api/v2/team/team-1/task");
    expect(calls.some((url) => url.includes("list_ids%5B%5D=list-1"))).toBe(true);
  });

  test("surfaces a helpful error when workspace_id is not a valid ClickUp workspace id", async () => {
    const client = new ClickUpTrackerClient(
      {
        kind: "clickup",
        endpoint: "https://api.clickup.com/api/v2",
        apiKey: "token",
        workspaceId: "60700898",
        spaceIds: [],
        folderIds: [],
        listIds: ["list-1"],
        activeStates: ["Todo"],
        activeStateSet: new Set(["todo"]),
        terminalStates: ["Done"],
        terminalStateSet: new Set(["done"])
      },
      createLogger({ enabled: false }),
      async () => jsonResponse({ err: "not found" }, 404)
    );

    await expect(client.fetchCandidateIssues()).rejects.toMatchObject({
      code: "clickup_invalid_workspace",
      message: expect.stringContaining("Workspace/team ID")
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
