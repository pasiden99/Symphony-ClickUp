import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { PlaywrightScreenshotCapturer } from "../src/codex/screenshots.js";

describe("PlaywrightScreenshotCapturer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test.runIf(process.env.RUN_PLAYWRIGHT_SCREENSHOT_TEST === "1")(
    "captures a local static page with Chromium",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "symphony-real-screenshot-"));
      tempDirs.push(root);
      const outputPath = path.join(root, "page.png");
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Review</title><main><h1>Review screenshot</h1></main>");
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Failed to bind local test server");
        }

        await new PlaywrightScreenshotCapturer().capture({
          url: `http://127.0.0.1:${address.port}`,
          outputPath,
          viewport: {
            width: 800,
            height: 600
          },
          fullPage: true,
          waitMs: 0
        });

        const captured = await stat(outputPath);
        expect(captured.size).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  );
});
