import { afterEach, describe, expect, test } from "vitest";

import { createHttpServer } from "../src/http.js";
import { createLogger } from "../src/logging.js";

describe("http server", () => {
  const apps: Array<ReturnType<typeof createHttpServer>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test("renders the dashboard as html", async () => {
    const app = createHttpServer(fakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).toContain("Symphony Runtime");
  });

  test("suppresses favicon noise", async () => {
    const app = createHttpServer(fakeOrchestrator(), createLogger({ enabled: false }));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/favicon.ico"
    });

    expect(response.statusCode).toBe(204);
  });
});

function fakeOrchestrator() {
  return {
    getRuntimeSnapshot() {
      return {
        generatedAt: new Date("2026-03-08T00:00:00.000Z").toISOString(),
        counts: {
          running: 0,
          retrying: 0
        },
        running: [],
        retrying: [],
        codexTotals: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          secondsRunning: 0
        },
        rateLimits: null,
        workflow: {
          path: "/tmp/WORKFLOW.md",
          promptTemplateEmpty: false
        },
        lastConfigError: null
      };
    },
    getIssueSnapshot() {
      return null;
    },
    async requestRefresh() {
      return {
        queued: true,
        coalesced: false
      };
    }
  };
}
