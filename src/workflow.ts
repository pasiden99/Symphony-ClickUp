import { access, readFile } from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";
import yaml from "js-yaml";

import { SymphonyError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";
import { isObject, nowIso } from "./utils.js";

export function resolveWorkflowPath(explicitPath: string | null | undefined, cwd: string): string {
  if (explicitPath && explicitPath.trim() !== "") {
    return path.resolve(cwd, explicitPath);
  }

  return path.resolve(cwd, "WORKFLOW.md");
}

export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  try {
    await access(workflowPath);
  } catch (error) {
    throw new SymphonyError("missing_workflow_file", `Workflow file not found: ${workflowPath}`, undefined, error);
  }

  const raw = await readFile(workflowPath, "utf8");
  return parseWorkflow(raw, workflowPath);
}

export function parseWorkflow(raw: string, workflowPath = "WORKFLOW.md"): WorkflowDefinition {
  let config: Record<string, unknown> = {};
  let promptBody = raw;

  if (raw.startsWith("---")) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
      throw new SymphonyError("workflow_parse_error", `Invalid YAML front matter in ${workflowPath}`);
    }

    const frontMatter = match[1] ?? "";
    try {
      const parsed = yaml.load(frontMatter);
      if (parsed === undefined) {
        config = {};
      } else if (!isObject(parsed)) {
        throw new SymphonyError(
          "workflow_front_matter_not_a_map",
          `Workflow front matter must decode to a map in ${workflowPath}`
        );
      } else {
        config = parsed;
      }
    } catch (error) {
      if (error instanceof SymphonyError) {
        throw error;
      }

      throw new SymphonyError("workflow_parse_error", `Failed to parse workflow YAML in ${workflowPath}`, undefined, error);
    }

    promptBody = match[2] ?? "";
  }

  return {
    filePath: workflowPath,
    config,
    promptTemplate: promptBody.trim(),
    loadedAt: nowIso()
  };
}

export function watchWorkflow(
  workflowPath: string,
  onReload: () => Promise<void> | void,
  onError?: (error: unknown) => void
): FSWatcher {
  const watcher = chokidar.watch(workflowPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50
    }
  });

  const triggerReload = async (): Promise<void> => {
    try {
      await onReload();
    } catch (error) {
      onError?.(error);
    }
  };

  watcher.on("add", triggerReload);
  watcher.on("change", triggerReload);
  watcher.on("error", (error) => onError?.(error));

  return watcher;
}
