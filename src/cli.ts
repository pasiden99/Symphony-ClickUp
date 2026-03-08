#!/usr/bin/env node

import { resolveWorkflowPath } from "./workflow.js";
import { SymphonyService } from "./service.js";

async function main(): Promise<void> {
  const { workflowArg, port } = parseArgs(process.argv.slice(2));
  const workflowPath = resolveWorkflowPath(workflowArg, process.cwd());
  const service = new SymphonyService({
    workflowPath,
    portOverride: port
  });

  const logger = service.getLogger();

  try {
    await service.start();
    logger.info({ workflow_path: workflowPath, port }, "symphony_started");
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "symphony_startup_failed");
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "symphony_stopping");
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

function parseArgs(args: string[]): { workflowArg: string | null; port: number | null } {
  let workflowArg: string | null = null;
  let port: number | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--port requires a value");
      }
      port = Number.parseInt(value, 10);
      if (!Number.isFinite(port) || port < 0) {
        throw new Error("--port must be a non-negative integer");
      }
      index += 1;
      continue;
    }

    if (!workflowArg) {
      workflowArg = arg ?? null;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return {
    workflowArg,
    port
  };
}

void main();
