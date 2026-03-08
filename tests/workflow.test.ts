import { describe, expect, test } from "vitest";

import { SymphonyError } from "../src/errors.js";
import { parseWorkflow, resolveWorkflowPath } from "../src/workflow.js";

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
});
