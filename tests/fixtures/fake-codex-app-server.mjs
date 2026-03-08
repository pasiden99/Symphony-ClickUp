#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let turnCounter = 0;

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
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }

  if (message.method === "turn/start") {
    turnCounter += 1;
    send({ id: message.id, result: { turn: { id: `turn-${turnCounter}` } } });

    const prompt = message.params?.input?.[0]?.text ?? "";
    if (prompt.includes("NEEDS_INPUT")) {
      send({ id: 900 + turnCounter, method: "item/tool/requestUserInput", params: { message: "Need approval" } });
      return;
    }

    send({
      method: "thread/tokenUsage/updated",
      params: {
        total_token_usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20
        }
      }
    });
    send({ method: "turn/completed", params: { message: "done" } });
  }
});
