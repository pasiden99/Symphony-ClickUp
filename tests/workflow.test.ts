import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { SymphonyError } from "../src/errors.js";
import { parseWorkflow, resolveWorkflowPath } from "../src/workflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("workflow parsing", () => {
  test("parses YAML front matter into config and prompt template", () => {
    const workflow = parseWorkflow(`---
tracker:
  kind: clickup
agent:
  max_turns: 7
---
Hello {{ issue.identifier }}
`);

    expect(workflow.config).toMatchObject({
      tracker: {
        kind: "clickup"
      },
      agent: {
        max_turns: 7
      }
    });
    expect(workflow.promptTemplate).toBe("Hello {{ issue.identifier }}");
  });

  test("rejects non-map front matter", () => {
    expect(() => parseWorkflow(`---
- invalid
---
Body`)).toThrowError(SymphonyError);
  });

  test("resolves explicit and default workflow paths", () => {
    expect(resolveWorkflowPath("nested/WORKFLOW.md", "/tmp/repo")).toBe("/tmp/repo/nested/WORKFLOW.md");
    expect(resolveWorkflowPath(null, "/tmp/repo")).toBe("/tmp/repo/WORKFLOW.md");
  });

  test("example workflow keeps PR creation as the Human Review gate", async () => {
    const workflow = await readFile(path.join(repoRoot, "WORKFLOW-EXAMPLE.md"), "utf8");

    expect(workflow).toContain("create or update the PR");
    expect(workflow).toContain("Move to `Human Review` only after the PR URL is visible");
    expect(workflow).toContain("try available GitHub fallbacks first");
    expect(workflow).toContain("record a blocker instead of moving to `Human Review`");
  });

  test("example workflow and docs keep merged PR branch cleanup guidance", async () => {
    const workflow = await readFile(path.join(repoRoot, "WORKFLOW-EXAMPLE.md"), "utf8");
    const docs = await readFile(path.join(repoRoot, "docs/user-guide/configuration.md"), "utf8");

    expect(workflow).toContain("delete the merged remote PR branch when possible");
    expect(docs).toContain("Automatically delete head branches");
    expect(docs).toContain("delete the merged remote PR branch");
  });
});
