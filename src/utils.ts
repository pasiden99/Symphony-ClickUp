import os from "node:os";
import path from "node:path";

export function normalizeStateName(value: string): string {
  return value.trim().toLowerCase();
}

export function coerceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function coerceInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function resolveEnvBackedString(value: unknown, env: NodeJS.ProcessEnv): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (!value.startsWith("$")) {
    return value;
  }

  const envKey = value.slice(1);
  if (!envKey) {
    return null;
  }

  const resolved = env[envKey];
  return resolved && resolved.trim() !== "" ? resolved : null;
}

export function expandPathLike(input: string, env: NodeJS.ProcessEnv, cwd: string): string {
  let value = input;

  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    value = env[envKey] ?? "";
  }

  if (value.startsWith("~")) {
    value = path.join(os.homedir(), value.slice(1));
  }

  if (path.isAbsolute(value)) {
    return path.normalize(value);
  }

  if (value.includes("/") || value.includes(path.sep) || value.startsWith(".")) {
    return path.resolve(cwd, value);
  }

  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function delayForAttempt(attempt: number, maxRetryBackoffMs: number): number {
  if (attempt <= 1) {
    return Math.min(10_000, maxRetryBackoffMs);
  }

  const exponential = 10_000 * 2 ** (attempt - 1);
  return Math.min(exponential, maxRetryBackoffMs);
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, limit);
  const results = new Array<R>(items.length);
  let index = 0;

  async function run(): Promise<void> {
    while (true) {
      const currentIndex = index;
      index += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => run()));
  return results;
}
