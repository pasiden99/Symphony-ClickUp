import { describe, expect, test } from "vitest";

import { buildContinuationPrompt, prependEnvironmentContext, renderIssuePrompt } from "../src/prompt.js";
import type { Issue } from "../src/types.js";

describe("prompt helpers", () => {
  test("renders the ClickUp task ID into the workflow prompt context", async () => {
    const prompt = await renderIssuePrompt("Task {{ issue.identifier }} uses {{ issue.clickup_task_id }}", baseIssue(), null);

    expect(prompt).toBe("Task CU-0 uses 868ht62zr");
  });

  test("continuation prompt stays compact while preserving task and turn context", () => {
    const prompt = buildContinuationPrompt(baseIssue(), 2, 3);

    expect(prompt).toContain("CU-0");
    expect(prompt).toContain("Continuation turn 2/3");
    expect(prompt).toContain("complete or blocked");
    expect(prompt.split(/\s+/).length).toBeLessThan(30);
  });

  test("prepends environment notices when blockers are detected", () => {
    const prompt = prependEnvironmentContext("Finish the task.", [
      "GitHub CLI PR access needs attention (GitHub CLI cannot access repository acme/private-repo: repository access check failed.); avoid repeated `gh` retries, try available PR fallbacks such as switching to a logged-in account with repo access, and block only if no PR path works."
    ]);

    expect(prompt).toContain("Environment preflight:");
    expect(prompt).toContain("acme/private-repo");
    expect(prompt).toContain("try available PR fallbacks");
    expect(prompt).toContain("block only if no PR path works");
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
