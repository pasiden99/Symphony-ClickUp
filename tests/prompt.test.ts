import { describe, expect, test } from "vitest";

import { buildContinuationPrompt, prependEnvironmentContext, renderIssuePrompt } from "../src/prompt.js";
import type { Issue } from "../src/types.js";

describe("prompt helpers", () => {
  test("renders the ClickUp task ID into the workflow prompt context", async () => {
    const prompt = await renderIssuePrompt("Task {{ issue.identifier }} uses {{ issue.clickup_task_id }}", baseIssue(), null);

    expect(prompt).toBe("Task CU-0 uses 868ht62zr");
  });

  test("continuation prompt forbids MCP ClickUp tools and repeats the raw task ID", () => {
    const prompt = buildContinuationPrompt(baseIssue(), 2, 3);

    expect(prompt).toContain("raw ClickUp task ID 868ht62zr");
    expect(prompt).toContain("Do not use CU-0 as a ClickUp task ID");
    expect(prompt).toContain("Do not call any mcp__clickup__* tools.");
  });

  test("prepends environment notices when blockers are detected", () => {
    const prompt = prependEnvironmentContext("Finish the task.", [
      "GitHub CLI authentication is unavailable for PR work in this environment: The token in default is invalid."
    ]);

    expect(prompt).toContain("Environment preflight:");
    expect(prompt).toContain("The token in default is invalid.");
    expect(prompt).toContain("Finish the task.");
  });
});

function baseIssue(): Issue {
  return {
    id: "868ht62zr",
    identifier: "CU-0",
    title: "Update README title",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: "https://app.clickup.com/t/868ht62zr",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}
