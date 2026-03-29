import type { Logger } from "pino";

import { ClickUpApiClient, type ClickUpRequestOptions } from "../clickup/api.js";
import { SymphonyError } from "../errors.js";
import type { ClickUpTrackerConfig } from "../types.js";

type FetchLike = typeof fetch;

const CLICKUP_TOOL_SPECS: DynamicToolSpec[] = [
  {
    name: "clickup_get_task",
    description: "Get the latest ClickUp task details for a task ID.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: {
          type: "string",
          description: "ClickUp task ID."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "clickup_update_task",
    description:
      "Update a ClickUp task. Supports status, name, description, and markdownDescription in one request.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: {
          type: "string",
          description: "ClickUp task ID."
        },
        status: {
          type: "string",
          description: "New ClickUp status name."
        },
        name: {
          type: "string",
          description: "Updated task title."
        },
        description: {
          type: "string",
          description: "Plain-text task description."
        },
        markdownDescription: {
          type: "string",
          description: "Markdown task description."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "clickup_get_task_comments",
    description: "Get recent ClickUp comments for a task.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: {
          type: "string",
          description: "ClickUp task ID."
        },
        start: {
          type: ["string", "number"],
          description: "Pagination timestamp from the oldest returned comment."
        },
        startId: {
          type: "string",
          description: "Pagination comment ID from the oldest returned comment."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "clickup_create_task_comment",
    description: "Create a new ClickUp task comment.",
    inputSchema: {
      type: "object",
      required: ["taskId", "commentText"],
      properties: {
        taskId: {
          type: "string",
          description: "ClickUp task ID."
        },
        commentText: {
          type: "string",
          description: "Comment body to post."
        },
        notifyAll: {
          type: "boolean",
          description: "Whether ClickUp should notify all assignees."
        }
      },
      additionalProperties: false
    }
  }
];

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DynamicToolResponse {
  success: boolean;
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
}

export interface DynamicToolHandler {
  listTools(): DynamicToolSpec[];
  callTool(name: string, args: unknown): Promise<DynamicToolResponse | null>;
}

export interface ClickUpDynamicToolContext {
  currentIssue?: {
    id: string;
    identifier: string;
  };
}

export class ClickUpDynamicToolHandler implements DynamicToolHandler {
  private readonly logger: Logger;
  private readonly apiClient: ClickUpApiClient;

  constructor(
    private readonly config: ClickUpTrackerConfig,
    logger: Logger,
    fetchImpl: FetchLike = fetch,
    requestTimeoutMs = 30_000,
    private readonly context: ClickUpDynamicToolContext = {}
  ) {
    this.logger = logger.child({ component: "clickup_dynamic_tools" });
    this.apiClient = new ClickUpApiClient(
      {
        endpoint: config.endpoint,
        apiKey: config.apiKey
      },
      fetchImpl,
      requestTimeoutMs
    );
  }

  listTools(): DynamicToolSpec[] {
    return CLICKUP_TOOL_SPECS;
  }

  async callTool(name: string, args: unknown): Promise<DynamicToolResponse | null> {
    try {
      switch (name) {
        case "clickup_get_task":
          return await this.getTask(args);
        case "clickup_update_task":
          return await this.updateTask(args);
        case "clickup_get_task_comments":
          return await this.getTaskComments(args);
        case "clickup_create_task_comment":
          return await this.createTaskComment(args);
        default:
          return null;
      }
    } catch (error) {
      this.logger.warn(
        {
          tool: name,
          error: error instanceof Error ? error.message : String(error)
        },
        "dynamic_tool_call_failed"
      );
      return failureResult({
        error: error instanceof SymphonyError ? error.code : "tool_call_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async getTask(args: unknown): Promise<DynamicToolResponse> {
    const taskId = this.resolveTaskId(asObject(args));
    const task = await this.requestJson(`/task/${encodeURIComponent(taskId)}`, {
      method: "GET",
      query: {
        include_markdown_description: "true"
      }
    });

    return successResult(task);
  }

  private async updateTask(args: unknown): Promise<DynamicToolResponse> {
    const parsed = asObject(args);
    const taskId = this.resolveTaskId(parsed);
    const body: Record<string, unknown> = {};

    if (parsed.status !== undefined) {
      body.status = asRequiredString(parsed.status, "status must be a string");
    }
    if (parsed.name !== undefined) {
      body.name = asRequiredString(parsed.name, "name must be a string");
    }
    if (parsed.description !== undefined) {
      body.description = asRequiredString(parsed.description, "description must be a string");
    }
    const markdownDescription = firstDefined(parsed.markdownDescription, parsed.markdown_description);
    if (markdownDescription !== undefined) {
      body.markdown_description = asRequiredString(
        markdownDescription,
        "markdownDescription must be a string"
      );
    }

    if (Object.keys(body).length === 0) {
      throw new SymphonyError(
        "clickup_invalid_tool_args",
        "clickup_update_task requires at least one of status, name, description, or markdownDescription"
      );
    }

    await this.requestJson(`/task/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      body
    });

    const task = await this.requestJson(`/task/${encodeURIComponent(taskId)}`, {
      method: "GET",
      query: {
        include_markdown_description: "true"
      }
    });

    return successResult(task);
  }

  private async getTaskComments(args: unknown): Promise<DynamicToolResponse> {
    const parsed = asObject(args);
    const taskId = this.resolveTaskId(parsed);
    const query: Record<string, string | undefined> = {};

    if (parsed.start !== undefined) {
      query.start = asStringLike(parsed.start, "start must be a string or number");
    }
    const startId = firstDefined(parsed.startId, parsed.start_id);
    if (startId !== undefined) {
      query.start_id = asRequiredString(startId, "startId must be a string");
    }

    const comments = await this.requestJson(`/task/${encodeURIComponent(taskId)}/comment`, {
      method: "GET",
      query
    });

    return successResult(comments);
  }

  private async createTaskComment(args: unknown): Promise<DynamicToolResponse> {
    const parsed = asObject(args);
    const taskId = this.resolveTaskId(parsed);
    const commentText = asRequiredString(
      firstDefined(parsed.commentText, parsed.comment_text),
      "commentText is required"
    );
    const body: Record<string, unknown> = {
      comment_text: commentText
    };

    const notifyAll = firstDefined(parsed.notifyAll, parsed.notify_all);
    if (notifyAll !== undefined) {
      if (typeof notifyAll !== "boolean") {
        throw new SymphonyError("clickup_invalid_tool_args", "notifyAll must be a boolean");
      }
      body.notify_all = notifyAll;
    }

    const response = await this.requestJson(`/task/${encodeURIComponent(taskId)}/comment`, {
      method: "POST",
      body
    });

    return successResult(response);
  }

  private resolveTaskId(args: Record<string, unknown>): string {
    const rawTaskId = asRequiredString(firstDefined(args.taskId, args.task_id), "taskId is required");
    const currentIssue = this.context.currentIssue;

    if (currentIssue && rawTaskId === currentIssue.identifier) {
      return currentIssue.id;
    }

    return rawTaskId;
  }

  private async requestJson(
    pathname: string,
    options: {
      method: "GET" | "POST" | "PUT";
      query?: Record<string, string | undefined>;
      body?: Record<string, unknown>;
    }
  ): Promise<unknown> {
    const requestOptions: ClickUpRequestOptions = {
      method: options.method,
      invalidJsonCode: "clickup_unknown_payload",
      networkFailureCode: "clickup_api_request"
    };

    if (options.query) {
      requestOptions.query = options.query;
    }
    if (options.body) {
      requestOptions.body = options.body;
    }

    return this.apiClient.requestJson(pathname, requestOptions);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SymphonyError("clickup_invalid_tool_args", "Tool arguments must be a JSON object");
  }

  return value as Record<string, unknown>;
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function asRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SymphonyError("clickup_invalid_tool_args", message);
  }

  return value;
}

function asStringLike(value: unknown, message: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return asRequiredString(value, message);
}

function successResult(payload: unknown): DynamicToolResponse {
  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function failureResult(payload: unknown): DynamicToolResponse {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}
