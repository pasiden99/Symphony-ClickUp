import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";

import { ClickUpApiClient, type ClickUpRequestOptions } from "../clickup/api.js";
import { SymphonyError } from "../errors.js";
import type { ClickUpTrackerConfig, ScreenshotConfig } from "../types.js";
import { sanitizeWorkspaceKey } from "../utils.js";
import { PlaywrightScreenshotCapturer, type ScreenshotCapturer } from "./screenshots.js";

type FetchLike = typeof fetch;

const BASE_CLICKUP_TOOL_SPECS: DynamicToolSpec[] = [
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

const SCREENSHOT_TOOL_SPEC: DynamicToolSpec = {
  name: "clickup_capture_review_screenshot",
  description: "Capture a local review screenshot, upload it to the current ClickUp task, and comment with review details.",
  inputSchema: {
    type: "object",
    required: ["taskId", "url", "label"],
    properties: {
      taskId: {
        type: "string",
        description: "ClickUp task ID."
      },
      url: {
        type: "string",
        description: "Local app URL to capture. Supports localhost, 127.0.0.1, [::1], and workspace-local file URLs."
      },
      label: {
        type: "string",
        description: "Short human-readable label for the screenshot."
      },
      viewportWidth: {
        type: "number",
        description: "Viewport width in pixels. Defaults to 1440."
      },
      viewportHeight: {
        type: "number",
        description: "Viewport height in pixels. Defaults to 900."
      },
      fullPage: {
        type: "boolean",
        description: "Whether to capture the full page. Defaults to true."
      },
      waitMs: {
        type: "number",
        description: "Optional delay before capture in milliseconds. Defaults to 0."
      }
    },
    additionalProperties: false
  }
};

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
  workspacePath?: string;
  screenshots?: ScreenshotConfig;
  screenshotCapturer?: ScreenshotCapturer;
}

export class ClickUpDynamicToolHandler implements DynamicToolHandler {
  private readonly logger: Logger;
  private readonly apiClient: ClickUpApiClient;
  private readonly screenshotCapturer: ScreenshotCapturer;
  private screenshotCount = 0;

  constructor(
    private readonly config: ClickUpTrackerConfig,
    logger: Logger,
    fetchImpl: FetchLike = fetch,
    requestTimeoutMs = 30_000,
    private readonly context: ClickUpDynamicToolContext = {}
  ) {
    this.logger = logger.child({ component: "clickup_dynamic_tools" });
    this.screenshotCapturer = context.screenshotCapturer ?? new PlaywrightScreenshotCapturer();
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
    return this.isScreenshotToolEnabled()
      ? [...BASE_CLICKUP_TOOL_SPECS, SCREENSHOT_TOOL_SPEC]
      : BASE_CLICKUP_TOOL_SPECS;
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
        case "clickup_capture_review_screenshot":
          if (!this.isScreenshotToolEnabled()) {
            return null;
          }
          return await this.captureReviewScreenshot(args);
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

  private async captureReviewScreenshot(args: unknown): Promise<DynamicToolResponse> {
    const screenshotConfig = this.context.screenshots;
    if (!screenshotConfig?.enabled) {
      throw new SymphonyError("screenshots_disabled", "Review screenshot capture is not enabled for this workflow");
    }
    if (!this.context.workspacePath) {
      throw new SymphonyError("screenshots_invalid_workspace", "Review screenshot capture requires a workspace path");
    }
    if (this.screenshotCount >= screenshotConfig.maxFilesPerAttempt) {
      throw new SymphonyError(
        "screenshots_limit_exceeded",
        `Review screenshot limit exceeded for this attempt (${screenshotConfig.maxFilesPerAttempt})`
      );
    }

    const parsed = asObject(args);
    const taskId = this.resolveTaskId(parsed);
    const url = asRequiredString(parsed.url, "url is required");
    const label = sanitizeLabel(asRequiredString(parsed.label, "label is required"));
    const viewport = {
      width: asBoundedInteger(firstDefined(parsed.viewportWidth, parsed.viewport_width), 1440, 320, 3840, "viewportWidth"),
      height: asBoundedInteger(firstDefined(parsed.viewportHeight, parsed.viewport_height), 900, 240, 2160, "viewportHeight")
    };
    const fullPage = asOptionalBoolean(firstDefined(parsed.fullPage, parsed.full_page), true, "fullPage");
    const waitMs = asBoundedInteger(firstDefined(parsed.waitMs, parsed.wait_ms), 0, 0, 10_000, "waitMs");

    const normalizedUrl = validateReviewScreenshotUrl(url, this.context.workspacePath);
    const issueKey = sanitizeWorkspaceKey(this.context.currentIssue?.identifier ?? taskId);
    const outputDir = path.join(screenshotConfig.outputDir, issueKey);
    await fs.mkdir(outputDir, { recursive: true });

    const filename = buildScreenshotFilename(label, this.screenshotCount + 1);
    const outputPath = path.join(outputDir, filename);

    await this.screenshotCapturer.capture({
      url: normalizedUrl,
      outputPath,
      viewport,
      fullPage,
      waitMs
    });

    const stats = await fs.stat(outputPath);
    if (!stats.isFile()) {
      throw new SymphonyError("screenshots_capture_failed", `Screenshot capture did not create a file: ${outputPath}`);
    }
    if (stats.size > screenshotConfig.maxFileBytes) {
      throw new SymphonyError(
        "screenshots_file_too_large",
        `Screenshot ${filename} is ${stats.size} bytes, exceeding max_file_bytes ${screenshotConfig.maxFileBytes}`
      );
    }

    const data = await fs.readFile(outputPath);
    const formData = new FormData();
    formData.append("filename", filename);
    formData.append("attachment", new Blob([new Uint8Array(data)], { type: "image/png" }), filename);
    const uploadResponse = await this.apiClient.requestJson(`/task/${encodeURIComponent(taskId)}/attachment`, {
      method: "POST",
      formData,
      invalidJsonCode: "clickup_unknown_payload",
      networkFailureCode: "clickup_api_request"
    });

    const commentResponse = await this.requestJson(`/task/${encodeURIComponent(taskId)}/comment`, {
      method: "POST",
      body: {
        comment_text: [
          "## Codex Screenshot",
          "",
          `Label: ${label}`,
          `URL: ${normalizedUrl}`,
          `Viewport: ${viewport.width}x${viewport.height}`,
          `Full page: ${fullPage ? "true" : "false"}`,
          `Filename: ${filename}`,
          "Upload status: attached to this task"
        ].join("\n")
      }
    });

    this.screenshotCount += 1;

    return successResult({
      localArtifactPath: outputPath,
      filename,
      url: normalizedUrl,
      viewport,
      fullPage,
      waitMs,
      uploadResponse,
      commentResponse
    });
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

  private isScreenshotToolEnabled(): boolean {
    return this.context.screenshots?.enabled === true;
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

function asBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new SymphonyError("clickup_invalid_tool_args", `${name} must be an integer`);
  }

  if (value < min || value > max) {
    throw new SymphonyError("clickup_invalid_tool_args", `${name} must be between ${min} and ${max}`);
  }

  return value;
}

function asOptionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new SymphonyError("clickup_invalid_tool_args", `${name} must be a boolean`);
  }

  return value;
}

function sanitizeLabel(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();

  if (sanitized === "") {
    throw new SymphonyError("clickup_invalid_tool_args", "label must contain at least one letter or number");
  }

  return sanitized;
}

function buildScreenshotFilename(label: string, index: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return `${String(index).padStart(2, "0")}-${stamp}-${safeLabel || "screenshot"}.png`;
}

function validateReviewScreenshotUrl(rawUrl: string, workspacePath: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SymphonyError("clickup_invalid_tool_args", "url must be an absolute local URL");
  }

  if (url.protocol === "file:") {
    const filePath = fileURLToPath(url);
    const workspacePrefix = ensureTrailingSeparator(path.resolve(workspacePath));
    const candidate = path.resolve(filePath);
    if (candidate !== path.resolve(workspacePath) && !candidate.startsWith(workspacePrefix)) {
      throw new SymphonyError("clickup_invalid_tool_args", "file URLs must point inside the active workspace");
    }
    return url.href;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SymphonyError("clickup_invalid_tool_args", "url must use http, https, or file protocol");
  }

  const hostname = url.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    throw new SymphonyError(
      "clickup_invalid_tool_args",
      "Only local review URLs are allowed for screenshots"
    );
  }

  return url.href;
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
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
