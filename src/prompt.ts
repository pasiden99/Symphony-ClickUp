import { Liquid } from "liquidjs";

import { SymphonyError } from "./errors.js";
import type { Issue } from "./types.js";

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: true,
  jsTruthy: true
});

export async function renderIssuePrompt(
  promptTemplate: string,
  issue: Issue,
  attempt: number | null
): Promise<string> {
  const template = promptTemplate.trim() || "You are working on an issue from ClickUp.";

  try {
    return await liquid.parseAndRender(template, {
      issue: serializeIssue(issue),
      attempt
    });
  } catch (error) {
    throw new SymphonyError("template_render_error", "Failed to render workflow prompt", undefined, error);
  }
}

export function buildContinuationPrompt(issue: Issue, turnNumber: number, maxTurns: number): string {
  return [
    `Continue working on ClickUp task ${issue.identifier}: ${issue.title}.`,
    "Use the existing thread history instead of restating the original task.",
    `This is continuation turn ${turnNumber} of ${maxTurns}.`,
    `For ClickUp task reads and mutations, use only Symphony's first-party tools with raw ClickUp task ID ${issue.id}.`,
    `Do not use ${issue.identifier} as a ClickUp task ID; it is only Symphony's issue identifier.`,
    "Do not call any mcp__clickup__* tools.",
    "Inspect the current workspace state, continue the implementation, and stop when the task is complete or blocked."
  ].join("\n");
}

function serializeIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    clickup_task_id: issue.id,
    identifier: issue.identifier,
    symphony_issue_identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    labels: [...issue.labels],
    blocked_by: issue.blockedBy.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt
  };
}
