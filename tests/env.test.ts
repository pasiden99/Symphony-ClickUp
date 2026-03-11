import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadProjectEnv, parseEnvFile } from "../src/env.js";

describe("env loading", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("parses quoted values and inline comments", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        'CLICKUP_API_TOKEN="token value"',
        "SYMPHONY_REPO_URL=https://github.com/example/repo.git # inline",
        "export LOG_LEVEL=debug"
      ].join("\n"),
      "test.env"
    );

    expect(parsed).toEqual({
      CLICKUP_API_TOKEN: "token value",
      SYMPHONY_REPO_URL: "https://github.com/example/repo.git",
      LOG_LEVEL: "debug"
    });
  });

  test("loads .env.local over .env but preserves shell env overrides", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-env-"));
    tempDirs.push(tempDir);

    await writeFile(
      path.join(tempDir, ".env"),
      ["CLICKUP_API_TOKEN=from-dotenv", "SYMPHONY_REPO_URL=https://github.com/example/base.git"].join("\n")
    );
    await writeFile(
      path.join(tempDir, ".env.local"),
      ["CLICKUP_API_TOKEN=from-local", "LOG_LEVEL=debug"].join("\n")
    );

    const env = await loadProjectEnv({
      workflowPath: path.join(tempDir, "WORKFLOW.md"),
      env: {
        SYMPHONY_REPO_URL: "https://github.com/example/from-shell.git"
      }
    });

    expect(env.CLICKUP_API_TOKEN).toBe("from-local");
    expect(env.SYMPHONY_REPO_URL).toBe("https://github.com/example/from-shell.git");
    expect(env.LOG_LEVEL).toBe("debug");
  });
});
