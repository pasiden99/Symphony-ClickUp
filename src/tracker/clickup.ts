import path from "node:path";
import { URL } from "node:url";

import type { Logger } from "pino";

import { SymphonyError } from "../errors.js";
import type { ClickUpTrackerConfig, Issue, TrackerClient } from "../types.js";
import { formatError, mapWithConcurrency, nowIso } from "../utils.js";

interface ClickUpTag {
  name?: string | null;
}

interface ClickUpPriority {
  priority?: string | null;
  orderindex?: string | null;
}

interface ClickUpStatus {
  status?: string | null;
  type?: string | null;
}

interface ClickUpDependency {
  task_id?: string | null;
  depends_on?: string | null;
  type?: number | string | null;
}

interface ClickUpTask {
  id?: string | null;
  custom_id?: string | null;
  custom_item_id?: number | null;
  name?: string | null;
  description?: string | null;
  text_content?: string | null;
  status?: ClickUpStatus | null;
  priority?: ClickUpPriority | null;
  url?: string | null;
  tags?: ClickUpTag[] | null;
  dependencies?: ClickUpDependency[] | null;
  date_created?: string | null;
  date_updated?: string | null;
}

interface ClickUpTeamTasksResponse {
  tasks?: ClickUpTask[];
  last_page?: boolean;
}

type FetchLike = typeof fetch;

export class ClickUpTrackerClient implements TrackerClient {
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: ClickUpTrackerConfig,
    logger: Logger,
    fetchImpl: FetchLike = fetch,
    requestTimeoutMs = 30_000
  ) {
    this.fetchImpl = fetchImpl;
    this.logger = logger.child({ component: "clickup_tracker" });
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchTasksByStates(this.config.activeStates, false, true);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    return this.fetchTasksByStates(stateNames, true, false);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const tasks = await mapWithConcurrency(issueIds, 5, async (issueId) => this.fetchTaskById(issueId));
    return tasks.flatMap((task) => (task ? [this.normalizeTask(task)] : []));
  }

  private async fetchTasksByStates(
    stateNames: string[],
    includeClosed: boolean,
    resolveBlockers: boolean
  ): Promise<Issue[]> {
    const collected: ClickUpTask[] = [];
    let page = 0;

    while (true) {
      const response = await this.requestJson<ClickUpTeamTasksResponse>(
        `/team/${encodeURIComponent(this.config.workspaceId)}/task`,
        {
          page: String(page),
          subtasks: "true",
          include_closed: includeClosed ? "true" : "false",
          include_markdown_description: "true",
          "statuses[]": stateNames,
          "space_ids[]": this.config.spaceIds,
          "project_ids[]": this.config.folderIds,
          "list_ids[]": this.config.listIds
        }
      );

      if (!response.tasks || !Array.isArray(response.tasks)) {
        throw new SymphonyError("clickup_unknown_payload", "ClickUp task response did not include a tasks array");
      }

      collected.push(...response.tasks);

      if (response.last_page === true || (response.last_page === undefined && response.tasks.length < 100)) {
        break;
      }

      page += 1;
    }

    let blockerMap = new Map<string, Issue>();
    if (resolveBlockers) {
      blockerMap = await this.loadBlockers(collected);
    }

    return collected
      .flatMap((task) => {
        try {
          return [this.normalizeTask(task, blockerMap)];
        } catch (error) {
          this.logger.warn(
            {
              err: formatError(error),
              task_id: task.id ?? null
            },
            "clickup_task_normalization_failed"
          );
          return [];
        }
      })
      .filter((issue) => issue.id && issue.identifier && issue.title && issue.state);
  }

  private async loadBlockers(tasks: ClickUpTask[]): Promise<Map<string, Issue>> {
    const blockerIds = new Set<string>();

    for (const task of tasks) {
      for (const blockerId of this.extractBlockerIds(task)) {
        blockerIds.add(blockerId);
      }
    }

    if (blockerIds.size === 0) {
      return new Map<string, Issue>();
    }

    const blockers = await mapWithConcurrency([...blockerIds], 5, async (blockerId) => {
      try {
        const task = await this.fetchTaskById(blockerId);
        return task ? this.normalizeTask(task) : null;
      } catch (error) {
        this.logger.warn(
          {
            blocker_id: blockerId,
            err: formatError(error)
          },
          "clickup_blocker_fetch_failed"
        );
        return null;
      }
    });

    return new Map(blockers.filter((issue): issue is Issue => issue !== null).map((issue) => [issue.id, issue]));
  }

  private async fetchTaskById(taskId: string): Promise<ClickUpTask | null> {
    const response = await this.requestJson<ClickUpTask>(`/task/${encodeURIComponent(taskId)}`, {
      include_markdown_description: "true"
    });

    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new SymphonyError("clickup_unknown_payload", `ClickUp task payload for ${taskId} was malformed`);
    }

    return response;
  }

  private normalizeTask(task: ClickUpTask, blockerMap = new Map<string, Issue>()): Issue {
    const id = asRequiredString(task.id, "ClickUp task id is missing");
    const title = asRequiredString(task.name, `ClickUp task ${id} name is missing`);
    const state = asRequiredString(task.status?.status, `ClickUp task ${id} status is missing`);
    const identifier =
      normalizeOptionalString(task.custom_id) ??
      (typeof task.custom_item_id === "number" ? `CU-${task.custom_item_id}` : `CU-${id}`);

    const labels = Array.isArray(task.tags)
      ? task.tags
          .map((tag) => normalizeOptionalString(tag.name))
          .filter((tag): tag is string => tag !== null)
          .map((tag) => tag.toLowerCase())
      : [];

    const blockedBy = this.extractBlockerIds(task).map((blockerId) => {
      const blocker = blockerMap.get(blockerId);
      return {
        id: blocker?.id ?? blockerId,
        identifier: blocker?.identifier ?? null,
        state: blocker?.state ?? null
      };
    });

    return {
      id,
      identifier,
      title,
      description: normalizeOptionalString(task.description) ?? normalizeOptionalString(task.text_content),
      priority: normalizePriority(task.priority),
      state,
      branchName: null,
      url: normalizeOptionalString(task.url),
      labels,
      blockedBy,
      createdAt: normalizeTimestamp(task.date_created),
      updatedAt: normalizeTimestamp(task.date_updated)
    };
  }

  private extractBlockerIds(task: ClickUpTask): string[] {
    const taskId = normalizeOptionalString(task.id);
    const ids = new Set<string>();

    for (const dependency of task.dependencies ?? []) {
      const candidates = [dependency.depends_on, dependency.task_id];
      for (const candidate of candidates) {
        const blockerId = normalizeOptionalString(candidate);
        if (!blockerId || blockerId === taskId) {
          continue;
        }

        ids.add(blockerId);
      }
    }

    return [...ids];
  }

  private async requestJson<T>(
    pathname: string,
    query: Record<string, string | string[] | undefined>
  ): Promise<T> {
    const response = await this.request(pathname, { method: "GET", query });

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new SymphonyError("clickup_unknown_payload", `ClickUp returned invalid JSON for ${pathname}`, undefined, error);
    }
  }

  private async request(
    pathname: string,
    options: {
      method: "GET" | "PUT";
      query?: Record<string, string | string[] | undefined>;
      body?: Record<string, unknown>;
    }
  ): Promise<Response> {
    const url = buildApiUrl(this.config.endpoint, pathname);

    for (const [key, rawValue] of Object.entries(options.query ?? {})) {
      if (rawValue === undefined) {
        continue;
      }

      if (Array.isArray(rawValue)) {
        for (const value of rawValue) {
          url.searchParams.append(key, value);
        }
        continue;
      }

      url.searchParams.set(key, rawValue);
    }

    const startedAt = Date.now();
    const signal = AbortSignal.timeout(this.requestTimeoutMs);

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: options.method,
        headers: {
          Authorization: this.config.apiKey,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        signal
      };
      if (options.body) {
        requestInit.body = JSON.stringify(options.body);
      }

      response = await this.fetchImpl(url, {
        ...requestInit
      });
    } catch (error) {
      throw new SymphonyError("clickup_api_request", `ClickUp request failed for ${url.pathname}`, undefined, error);
    }

    const limitHeaders = {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset")
    };

    this.logger.debug(
      {
        method: options.method,
        path: url.pathname,
        status: response.status,
        duration_ms: Date.now() - startedAt,
        rate_limit: limitHeaders,
        at: nowIso()
      },
      "clickup_request_completed"
    );

    if (response.status === 429) {
      throw new SymphonyError("clickup_api_rate_limit", `ClickUp rate limit exceeded for ${url.pathname}`, {
        rateLimit: limitHeaders
      });
    }

    if (!response.ok) {
      throw this.toStatusError(url.pathname, response.status, limitHeaders);
    }

    return response;
  }

  private toStatusError(
    pathname: string,
    status: number,
    rateLimit: { limit: string | null; remaining: string | null; reset: string | null }
  ): SymphonyError {
    const details = {
      status,
      rateLimit,
      path: pathname
    };

    if (status === 404 && pathname.endsWith(`/team/${encodeURIComponent(this.config.workspaceId)}/task`)) {
      return new SymphonyError(
        "clickup_invalid_workspace",
        `ClickUp returned 404 for ${pathname}. Verify tracker.workspace_id is the ClickUp Workspace/team ID from API v2, not a Space or List ID.`,
        details
      );
    }

    return new SymphonyError("clickup_api_status", `ClickUp responded with ${status} for ${pathname}`, details);
  }
}

function normalizeBaseUrl(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}

function buildApiUrl(endpoint: string, pathname: string): URL {
  const url = new URL(normalizeBaseUrl(endpoint));
  const normalizedPath = pathname.replace(/^\/+/, "");
  url.pathname = path.posix.join(url.pathname, normalizedPath);
  return url;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRequiredString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new SymphonyError("clickup_unknown_payload", message);
  }

  return normalized;
}

function normalizePriority(priority: ClickUpPriority | null | undefined): number | null {
  if (!priority) {
    return null;
  }

  const candidates = [priority.orderindex, priority.priority];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric)) {
    return new Date(numeric).toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
