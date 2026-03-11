import { readFile } from "node:fs/promises";
import path from "node:path";

import { SymphonyError } from "./errors.js";

export async function loadProjectEnv(options: {
  workflowPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  const env = options.env ?? process.env;
  const workflowDir = path.dirname(path.resolve(options.workflowPath));

  const fileValues = {
    ...(await readEnvFile(path.join(workflowDir, ".env"))),
    ...(await readEnvFile(path.join(workflowDir, ".env.local")))
  };

  for (const [key, value] of Object.entries(fileValues)) {
    if (!env[key] || env[key]?.trim() === "") {
      env[key] = value;
    }
  }

  return env;
}

export function parseEnvFile(raw: string, source = ".env"): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      throw new SymphonyError("invalid_env_file", `Invalid env assignment in ${source} at line ${index + 1}`);
    }

    const key = match[1]!;
    const rawValue = match[2] ?? "";
    parsed[key] = normalizeEnvValue(rawValue);
  }

  return parsed;
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseEnvFile(raw, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function normalizeEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      return inner
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\t", "\t")
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\");
    }

    return inner;
  }

  const commentIndex = trimmed.search(/\s#/);
  return commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex).trimEnd();
}
