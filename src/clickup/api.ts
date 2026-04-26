import path from "node:path";
import { URL } from "node:url";

import type { Logger } from "pino";

import { SymphonyError } from "../errors.js";

type FetchLike = typeof fetch;

export interface ClickUpApiConfig {
  endpoint: string;
  apiKey: string;
}

export interface ClickUpRateLimitDetails {
  limit: string | null;
  remaining: string | null;
  reset: string | null;
}

export interface ClickUpResponseMeta {
  method: "GET" | "POST" | "PUT";
  path: string;
  status: number;
  durationMs: number;
  rateLimit: ClickUpRateLimitDetails;
}

export interface ClickUpRequestOptions {
  method: "GET" | "POST" | "PUT";
  query?: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
  formData?: FormData;
  invalidJsonCode?: string;
  networkFailureCode?: string;
  onResponse?: (meta: ClickUpResponseMeta) => void;
  statusError?: (pathname: string, status: number, rateLimit: ClickUpRateLimitDetails) => SymphonyError;
}

export class ClickUpApiClient {
  constructor(
    private readonly config: ClickUpApiConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly requestTimeoutMs = 30_000
  ) {}

  async requestJson<T>(pathname: string, options: ClickUpRequestOptions): Promise<T> {
    const response = await this.request(pathname, options);

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new SymphonyError(
        options.invalidJsonCode ?? "clickup_unknown_payload",
        `ClickUp returned invalid JSON for ${pathname}`,
        undefined,
        error
      );
    }
  }

  async request(pathname: string, options: ClickUpRequestOptions): Promise<Response> {
    if (options.body && options.formData) {
      throw new SymphonyError("clickup_invalid_request", "ClickUp request cannot include both JSON and multipart bodies");
    }

    const url = buildClickUpApiUrl(this.config.endpoint, pathname);
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
    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: options.method,
        headers: {
          Authorization: this.config.apiKey,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      };
      if (options.body) {
        requestInit.body = JSON.stringify(options.body);
      } else if (options.formData) {
        requestInit.body = options.formData;
      }

      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new SymphonyError(
        options.networkFailureCode ?? "clickup_api_request",
        `ClickUp request failed for ${url.pathname}`,
        undefined,
        error
      );
    }

    const rateLimit: ClickUpRateLimitDetails = {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset")
    };

    options.onResponse?.({
      method: options.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
      rateLimit
    });

    if (response.status === 429) {
      throw new SymphonyError("clickup_api_rate_limit", `ClickUp rate limit exceeded for ${url.pathname}`, {
        rateLimit
      });
    }

    if (!response.ok) {
      throw (
        options.statusError?.(url.pathname, response.status, rateLimit) ??
        new SymphonyError("clickup_api_request", `ClickUp returned ${response.status} for ${url.pathname}`, {
          status: response.status,
          rateLimit,
          path: url.pathname
        })
      );
    }

    return response;
  }
}

export function buildClickUpApiUrl(endpoint: string, pathname: string): URL {
  const url = new URL(normalizeEndpoint(endpoint));
  const normalizedPath = pathname.replace(/^\/+/, "");
  url.pathname = path.posix.join(url.pathname, normalizedPath);
  return url;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}
