#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let sawLegacyToolSpec = false;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({ id: message.id, result: { ok: true } });
    return;
  }

  if (message.method === "thread/start") {
    if (Array.isArray(message.params?.dynamicTools) || Array.isArray(message.params?.dynamic_tools)) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: "dynamic tools not supported"
        }
      });
      return;
    }

    const tools = message.params?.tools;
    if (Array.isArray(tools) && tools.some((tool) => tool?.name === "clickup_get_task")) {
      sawLegacyToolSpec = true;
    }

    send({ id: message.id, result: { thread: { id: "thread-legacy" } } });
    return;
  }

  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-legacy" } } });

    if (!sawLegacyToolSpec) {
      process.stderr.write("legacy tools fallback was not used\n");
      process.exitCode = 1;
      return;
    }

    send({
      method: "turn/completed",
      params: {
        message: "done"
      }
    });
  }
});
