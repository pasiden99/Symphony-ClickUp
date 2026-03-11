#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const CODEX_COMMAND_PATH = execFileSync("/bin/zsh", ["-lc", "which codex"], {
  encoding: "utf8"
}).trim();
const CODEX_WRAPPER_PATH = realpathSync(CODEX_COMMAND_PATH);
const CODEX_PACKAGE_ROOT = path.resolve(CODEX_WRAPPER_PATH, "..", "..");
const CODEX_NATIVE_BINARY_PATH = execFileSync(
  "/bin/zsh",
  [
    "-lc",
    `find ${shellQuote(path.join(CODEX_PACKAGE_ROOT, "node_modules", "@openai"))} -path '*/vendor/*/codex/codex' -type f | head -n 1`
  ],
  {
    encoding: "utf8"
  }
).trim();
const DEFAULT_COMMAND = process.env.CODEX_APP_SERVER_COMMAND ?? `${CODEX_NATIVE_BINARY_PATH} app-server`;
const DEFAULT_COMMAND_BIN = CODEX_NATIVE_BINARY_PATH;
const DEFAULT_COMMAND_ARGS = ["app-server"];
const DEFAULT_TOOL_NAME = "probe_ping_tool";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PROBE_TIMEOUT_MS ?? "45000", 10);
const DEFAULT_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.PROBE_REQUEST_TIMEOUT_MS ?? "12000", 10);

const TOOL_SPEC = {
  name: DEFAULT_TOOL_NAME,
  description: "Returns a deterministic probe payload.",
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: {
      value: {
        type: "string",
        description: "Probe string."
      }
    },
    additionalProperties: false
  }
};

const CANDIDATES = [
  {
    name: "thread_start_dynamicTools",
    buildThreadStart: () => ({
      dynamicTools: [TOOL_SPEC]
    })
  },
  {
    name: "thread_start_dynamic_tools",
    buildThreadStart: () => ({
      dynamic_tools: [TOOL_SPEC]
    })
  },
  {
    name: "thread_start_tools",
    buildThreadStart: () => ({
      tools: [TOOL_SPEC]
    })
  },
  {
    name: "thread_start_config_dynamicTools",
    buildThreadStart: () => ({
      config: {
        dynamicTools: [TOOL_SPEC]
      }
    })
  },
  {
    name: "thread_start_config_dynamic_tools",
    buildThreadStart: () => ({
      config: {
        dynamic_tools: [TOOL_SPEC]
      }
    })
  },
  {
    name: "thread_start_config_tools",
    buildThreadStart: () => ({
      config: {
        tools: [TOOL_SPEC]
      }
    })
  }
];

async function main() {
  const requestedCandidate = process.argv[2] ?? null;
  const candidates = requestedCandidate
    ? CANDIDATES.filter((candidate) => candidate.name === requestedCandidate)
    : CANDIDATES;

  if (candidates.length === 0) {
    console.error(`Unknown candidate: ${requestedCandidate}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const candidate of candidates) {
    results.push(await runCandidate(candidate));
  }

  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
}

async function runCandidate(candidate) {
  const child = process.env.CODEX_APP_SERVER_COMMAND
    ? spawn("/bin/zsh", ["-lc", DEFAULT_COMMAND], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      })
    : spawn(DEFAULT_COMMAND_BIN, DEFAULT_COMMAND_ARGS, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      });

  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let nextId = 1;
  let stdoutBuffer = "";
  const pending = new Map();
  const notifications = [];
  const requests = [];
  const stderr = [];
  let threadId = null;
  let turnId = null;
  let finalStatus = "unknown";
  let finalMessage = null;
  let toolCall = null;

  const send = (payload) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method} response`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      send({ id, method, params });
    });
  };

  const closeWithError = (message) => {
    for (const { reject } of pending.values()) {
      reject(new Error(message));
    }
    pending.clear();
  };

  const maybeResolveCompletion = () => finalStatus !== "unknown";

  child.on("error", (error) => {
    closeWithError(`probe child error: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (!maybeResolveCompletion()) {
      closeWithError(`probe child exited before completion: code=${code ?? "null"} signal=${signal ?? "null"}`);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (rawLine === "") {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        notifications.push({ method: "probe/invalid-json", raw: rawLine });
        continue;
      }

      if (typeof parsed.id === "number" && pending.has(parsed.id)) {
        const deferred = pending.get(parsed.id);
        pending.delete(parsed.id);
        if ("error" in parsed) {
          deferred.reject(new Error(JSON.stringify(parsed.error)));
        } else {
          deferred.resolve(parsed.result);
        }
        continue;
      }

      if (typeof parsed.method === "string" && typeof parsed.id === "number") {
        requests.push(parsed);

        if (parsed.method === "item/tool/call") {
          toolCall = parsed.params;
          send({
            id: parsed.id,
            result: {
              success: true,
              contentItems: [
                {
                  type: "inputText",
                  text: JSON.stringify({
                    ok: true,
                    source: "probe",
                    candidate: candidate.name
                  })
                }
              ]
            }
          });
          continue;
        }

        if (parsed.method === "item/tool/requestUserInput") {
          send({
            id: parsed.id,
            result: {
              answers: {}
            }
          });
          continue;
        }

        send({
          id: parsed.id,
          result: {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({ error: "unsupported_probe_request" })
              }
            ]
          }
        });
        continue;
      }

      if (typeof parsed.method === "string") {
        notifications.push(parsed);

        if (parsed.method === "thread/started") {
          threadId = parsed.params?.thread_id ?? threadId;
        }
        if (parsed.method === "turn/started") {
          turnId = parsed.params?.turn_id ?? turnId;
        }
        if (parsed.method === "turn/completed") {
          finalStatus = "completed";
          finalMessage = parsed.params?.message ?? null;
        }
        if (parsed.method === "turn/failed") {
          finalStatus = "failed";
          finalMessage = parsed.params?.message ?? null;
        }
        if (parsed.method === "turn/cancelled") {
          finalStatus = "cancelled";
          finalMessage = parsed.params?.message ?? null;
        }
      }
    }
  });

  try {
    await request("initialize", {
      clientInfo: {
        name: "symphony-probe",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    send({ method: "initialized" });

    const threadResult = await request("thread/start", {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      developerInstructions: [
        `A first-party dynamic tool named ${DEFAULT_TOOL_NAME} may be available.`,
        `If it is available, call ${DEFAULT_TOOL_NAME} with {"value":"hello"} before doing anything else.`,
        `If it is not available, say exactly TOOL_UNAVAILABLE.`
      ].join(" "),
      ...candidate.buildThreadStart()
    });

    threadId = threadResult?.thread?.id ?? null;
    if (!threadId) {
      throw new Error("thread/start did not return thread.id");
    }

    const turnResult = await request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: `Call ${DEFAULT_TOOL_NAME} with {"value":"hello"} if available, then say TOOL_USED. Otherwise say TOOL_UNAVAILABLE.`
        }
      ],
      cwd: process.cwd(),
      approvalPolicy: "never"
    });

    turnId = turnResult?.turn?.id ?? null;

    const startedAt = Date.now();
    while (!maybeResolveCompletion() && Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
      await sleep(100);
    }

    if (!maybeResolveCompletion()) {
      finalStatus = "timeout";
    }
  } catch (error) {
    finalStatus = "error";
    finalMessage = error instanceof Error ? error.message : String(error);
  } finally {
    await terminateChild(child);
  }

  const toolRequested = requests.some((requestItem) => requestItem.method === "item/tool/call");
  const agentMessages = notifications
    .filter((notification) => typeof notification.params?.message === "string")
    .map((notification) => ({
      method: notification.method,
      message: notification.params.message
    }));

  return {
    candidate: candidate.name,
    threadId,
    turnId,
    finalStatus,
    finalMessage,
    toolRequested,
    toolCall,
    requestMethods: requests.map((requestItem) => requestItem.method),
    notificationMethods: notifications.map((notification) => notification.method),
    agentMessages,
    stderr: stderr.join("")
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(1_500).then(() => false)
  ]);

  if (exited) {
    return;
  }

  child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(1_500)
  ]);
}

await main();
