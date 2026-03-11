#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let turnCounter = 0;
let pendingUserInputResponseId = null;
let pendingToolResponseId = null;
let sawClickUpToolSpec = false;
let sawV2ThreadFlags = false;

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
    const tools = message.params?.dynamicTools;
    if (Array.isArray(tools) && tools.some((tool) => tool?.name === "clickup_get_task")) {
      sawClickUpToolSpec = true;
    }
    if (
      typeof message.params?.experimentalRawEvents === "boolean" &&
      typeof message.params?.persistExtendedHistory === "boolean"
    ) {
      sawV2ThreadFlags = true;
    }
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }

  if (message.method === "turn/start") {
    turnCounter += 1;
    send({ id: message.id, result: { turn: { id: `turn-${turnCounter}` } } });

    const prompt = message.params?.input?.[0]?.text ?? "";
    if (prompt.includes("NEEDS_INPUT")) {
      pendingUserInputResponseId = 900 + turnCounter;
      send({
        id: pendingUserInputResponseId,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: `turn-${turnCounter}`,
          itemId: `item-${turnCounter}`,
          questions: [
            {
              id: "auth_state",
              header: "Auth",
              question: "Need approval"
            }
          ]
        }
      });
      return;
    }

    if (prompt.includes("USE_TOOL")) {
      if (!sawClickUpToolSpec) {
        process.stderr.write("thread/start missing clickup_get_task dynamicTools spec\n");
        process.exitCode = 1;
        return;
      }

      if (!sawV2ThreadFlags) {
        process.stderr.write("thread/start missing v2 thread flags\n");
        process.exitCode = 1;
        return;
      }

      pendingToolResponseId = 700 + turnCounter;
      send({
        id: pendingToolResponseId,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: `turn-${turnCounter}`,
          callId: `call-${turnCounter}`,
          tool: "clickup_get_task",
          arguments: {
            taskId: "123"
          }
        }
      });
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
    return;
  }

  if (pendingUserInputResponseId !== null && message.id === pendingUserInputResponseId) {
    const answers = message.result?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      process.stderr.write("requestUserInput response missing answers object\n");
      process.exitCode = 1;
      return;
    }

    const authStateAnswers = answers.auth_state?.answers;
    if (!Array.isArray(authStateAnswers)) {
      process.stderr.write("requestUserInput response missing question answers array\n");
      process.exitCode = 1;
      return;
    }

    pendingUserInputResponseId = null;
    send({ method: "turn/failed", params: { message: "Interactive input required" } });
    return;
  }

  if (pendingToolResponseId !== null && message.id === pendingToolResponseId) {
    if (message.result?.success !== true) {
      process.stderr.write("dynamic tool call did not succeed\n");
      process.exitCode = 1;
      return;
    }

    const contentItems = message.result?.contentItems;
    if (!Array.isArray(contentItems) || contentItems[0]?.type !== "inputText") {
      process.stderr.write("dynamic tool call missing content items\n");
      process.exitCode = 1;
      return;
    }

    pendingToolResponseId = null;
    send({
      method: "thread/tokenUsage/updated",
      params: {
        total_token_usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30
        }
      }
    });
    send({ method: "turn/completed", params: { message: "tool done" } });
  }
});
