import type { FSWatcher } from "chokidar";
import Fastify from "fastify";
import type { Logger } from "pino";

import { AgentRunner } from "./agent-runner.js";
import { resolveEffectiveConfig } from "./config.js";
import { loadProjectEnv } from "./env.js";
import { SymphonyError } from "./errors.js";
import { startHttpServer } from "./http.js";
import { createLogger } from "./logging.js";
import { Orchestrator } from "./orchestrator.js";
import type { EffectiveConfig, WorkflowDefinition } from "./types.js";
import { loadWorkflow, watchWorkflow } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";
import { ClickUpTrackerClient } from "./tracker/clickup.js";

export interface SymphonyServiceOptions {
  workflowPath: string;
  portOverride: number | null;
  logger?: Logger;
}

export class SymphonyService {
  private readonly logger: Logger;
  private readonly workflowPath: string;
  private readonly portOverride: number | null;
  private watcher: FSWatcher | null = null;
  private httpServer: ReturnType<typeof Fastify> | null = null;
  private orchestrator: Orchestrator | null = null;
  private config: EffectiveConfig | null = null;
  private workflow: WorkflowDefinition | null = null;

  constructor(options: SymphonyServiceOptions) {
    this.workflowPath = options.workflowPath;
    this.portOverride = options.portOverride;
    this.logger = options.logger ?? createLogger();
  }

  async start(): Promise<void> {
    await loadProjectEnv({ workflowPath: this.workflowPath });
    const workflow = await loadWorkflow(this.workflowPath);
    const config = resolveEffectiveConfig(workflow, { workflowPath: this.workflowPath });

    const workspaceManager = new WorkspaceManager(config, this.logger);
    const trackerFactory = (nextConfig: EffectiveConfig) =>
      new ClickUpTrackerClient(nextConfig.tracker, this.logger);
    const agentRunner = new AgentRunner(config, trackerFactory(config), workspaceManager, this.logger);
    const orchestrator = new Orchestrator(
      config,
      workflow,
      trackerFactory,
      workspaceManager,
      agentRunner,
      this.logger
    );

    await orchestrator.start();

    const port = this.portOverride ?? config.server.port;
    if (port !== null) {
      this.httpServer = await startHttpServer(orchestrator, this.logger, port);
    }

    this.workflow = workflow;
    this.config = config;
    this.orchestrator = orchestrator;
    this.watcher = watchWorkflow(
      this.workflowPath,
      async () => {
        await this.reloadWorkflow();
      },
      (error) => {
        this.logger.error({ err: error instanceof Error ? error.message : String(error) }, "workflow_watch_error");
      }
    );
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;

    await this.orchestrator?.stop();
    this.orchestrator = null;

    if (this.httpServer) {
      await this.httpServer.close();
      this.httpServer = null;
    }
  }

  getLogger(): Logger {
    return this.logger;
  }

  private async reloadWorkflow(): Promise<void> {
    if (!this.orchestrator) {
      return;
    }

    try {
      await loadProjectEnv({ workflowPath: this.workflowPath });
      const workflow = await loadWorkflow(this.workflowPath);
      const config = resolveEffectiveConfig(workflow, { workflowPath: this.workflowPath });
      this.workflow = workflow;
      this.config = config;
      this.orchestrator.updateWorkflow(workflow, config);
      this.logger.info({ workflow_path: this.workflowPath }, "workflow_reloaded");
    } catch (error) {
      const workflowError =
        error instanceof SymphonyError
          ? error
          : new SymphonyError("workflow_reload_failed", error instanceof Error ? error.message : String(error));
      this.orchestrator.applyInvalidWorkflow(workflowError);
    }
  }
}
