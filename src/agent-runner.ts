import type { Logger } from "pino";

import { isActiveState } from "./config.js";
import { CodexAppServerClient, type CodexTurnResult } from "./codex/client.js";
import { ClickUpDynamicToolHandler } from "./codex/dynamic-tools.js";
import { SymphonyError } from "./errors.js";
import { buildContinuationPrompt, renderIssuePrompt } from "./prompt.js";
import type { EffectiveConfig, Issue, LiveSessionEvent, RunAttemptResult, TrackerClient } from "./types.js";
import { formatError } from "./utils.js";
import { WorkspaceManager } from "./workspace.js";

export interface RunAttemptOptions {
  issue: Issue;
  attempt: number | null;
  workflowPromptTemplate: string;
  onEvent: (event: LiveSessionEvent) => void;
  signal?: AbortSignal;
}

export class AgentRunner {
  private readonly logger: Logger;

  constructor(
    private config: EffectiveConfig,
    private readonly tracker: TrackerClient,
    private readonly workspaceManager: WorkspaceManager,
    logger: Logger
  ) {
    this.logger = logger.child({ component: "agent_runner" });
  }

  updateConfig(config: EffectiveConfig): void {
    this.config = config;
    this.workspaceManager.updateConfig(config);
  }

  async runAttempt(options: RunAttemptOptions): Promise<RunAttemptResult> {
    const { issue, attempt, workflowPromptTemplate, onEvent, signal } = options;
    let workspacePath = "";
    let session: Awaited<ReturnType<CodexAppServerClient["startSession"]>> | null = null;
    let finalIssue = issue;
    let turnCount = 0;

    const onAbort = async (): Promise<never> => {
      if (session) {
        await session.close();
      }

      throw new SymphonyError("canceled_by_reconciliation", `Run canceled for ${issue.identifier}`);
    };

    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              void onAbort().then(
                () => undefined,
                (error) => reject(error)
              );
            },
            { once: true }
          );
        })
      : null;

    try {
      const workspace = await this.workspaceManager.ensureForIssue(issue.identifier);
      workspacePath = workspace.path;

      await this.workspaceManager.cleanupTransientArtifacts(workspace.path);
      await this.workspaceManager.runHook("beforeRun", workspace.path);

      this.workspaceManager.assertInsideWorkspaceRoot(workspace.path);

      const codexClient = new CodexAppServerClient(
        this.config.codex,
        this.logger,
        new ClickUpDynamicToolHandler(this.config.tracker, this.logger, fetch, 30_000, {
          currentIssue: {
            id: issue.id,
            identifier: issue.identifier
          }
        })
      );
      session = await raceAbort(
        codexClient.startSession({
          workspacePath: workspace.path,
          onEvent
        }),
        abortPromise
      );

      while (turnCount < this.config.agent.maxTurns) {
        turnCount += 1;
        const prompt =
          turnCount === 1
            ? await renderIssuePrompt(workflowPromptTemplate, finalIssue, attempt)
            : buildContinuationPrompt(finalIssue, turnCount, this.config.agent.maxTurns);

        const turnResult = await raceAbort(
          session.runTurn({
            prompt,
            title: `${finalIssue.identifier}: ${finalIssue.title}`
          }),
          abortPromise
        );

        if (turnResult.status !== "completed") {
          return {
            status: mapTurnStatus(turnResult),
            issue: finalIssue,
            attempt,
            workspacePath,
            error: turnResult.error,
            turnCount
          };
        }

        const refreshed = await raceAbort(this.tracker.fetchIssueStatesByIds([finalIssue.id]), abortPromise);
        const refreshedIssue = refreshed[0];
        if (!refreshedIssue) {
          throw new SymphonyError("clickup_unknown_payload", `Tracker did not return task ${finalIssue.id} after turn completion`);
        }

        finalIssue = refreshedIssue;
        if (!isActiveState(this.config, finalIssue.state)) {
          break;
        }
      }

      return {
        status: "succeeded",
        issue: finalIssue,
        attempt,
        workspacePath,
        error: null,
        turnCount
      };
    } catch (error) {
      if (error instanceof SymphonyError && error.code === "canceled_by_reconciliation") {
        return {
          status: "canceled_by_reconciliation",
          issue: finalIssue,
          attempt,
          workspacePath,
          error: error.message,
          turnCount
        };
      }

      const code = error instanceof SymphonyError ? error.code : null;
      if (code === "turn_timeout") {
        return {
          status: "timed_out",
          issue: finalIssue,
          attempt,
          workspacePath,
          error: error instanceof Error ? error.message : String(error),
          turnCount
        };
      }

      return {
        status: "failed",
        issue: finalIssue,
        attempt,
        workspacePath,
        error: formatError(error),
        turnCount
      };
    } finally {
      if (session) {
        await session.close().catch(() => undefined);
      }

      if (workspacePath) {
        await this.workspaceManager.runHookBestEffort("afterRun", workspacePath);
      }
    }
  }
}

async function raceAbort<T>(promise: Promise<T>, abortPromise: Promise<never> | null): Promise<T> {
  if (!abortPromise) {
    return promise;
  }

  return Promise.race([promise, abortPromise]);
}

function mapTurnStatus(result: CodexTurnResult): RunAttemptResult["status"] {
  if (result.status === "cancelled") {
    return "failed";
  }

  return "failed";
}
