import test from "node:test";
import assert from "node:assert/strict";

const { wrapChatCompletionJsonAsResponsesSse, maybeWrapForcedNonStreamingResponsesJson } =
  await import("../../open-sse/handlers/chatCore/responsesJsonToSse.ts");

function chatCompletion(content = "hi") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

test("wraps non-streaming chat JSON as Responses SSE ending in response.completed", async () => {
  const response = wrapChatCompletionJsonAsResponsesSse(chatCompletion("hello"), {
    "X-OmniRoute-Cache": "MISS",
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("X-OmniRoute-Cache"), "MISS");
  const sse = await response.text();
  assert.match(sse, /event: response\.created/);
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /hello/);
  assert.match(sse, /data: \[DONE\]/);
});

test("injection: returning JSON early for a 200 chat completion goes red", async () => {
  const response = wrapChatCompletionJsonAsResponsesSse(chatCompletion());
  assert.notEqual(response.headers.get("Content-Type"), "application/json");
});

test("maybeWrapForcedNonStreamingResponsesJson keeps JSON when the client did not ask for SSE", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: false,
    body: chatCompletion("plain"),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.headers.get("Content-Type"), "application/json");
  const payload = JSON.parse(await response.text());
  assert.equal(payload.choices[0].message.content, "plain");
});

test("maybeWrapForcedNonStreamingResponsesJson wraps JSON when the client asked for SSE", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body: chatCompletion("stream-me"),
    headers: { "Content-Type": "application/json", "X-OmniRoute-Cache": "MISS" },
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const sse = await response.text();
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /stream-me/);
});

function events(sse: string): Array<Record<string, unknown>> {
  return sse
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("event: "))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines[0].slice(7);
      const data = JSON.parse(lines[1].slice(6)) as Record<string, unknown>;
      assert.equal(data.type, event);
      return data;
    });
}

test("already-translated Responses JSON streams full text and preserves terminal metadata", async () => {
  const body = {
    id: "resp_original",
    object: "response",
    status: "completed",
    model: "claude-sonnet-5",
    output: [
      {
        id: "msg_original",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "xin chao", annotations: [] }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body,
    headers: { "Content-Type": "application/json", "X-OmniRoute-Cache": "MISS" },
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("X-OmniRoute-Cache"), "MISS");
  const sse = await response.text();
  const emitted = events(sse);
  assert.deepEqual(
    emitted.map((event) => event.type),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]
  );
  assert.equal(emitted[4].delta, "xin chao");
  assert.deepEqual((emitted[2].item as Record<string, unknown>).content, []);
  assert.deepEqual(emitted.at(-1)?.response, body);
  assert.match(sse, /data: \[DONE\]/);
});

test("already-translated Responses JSON preserves custom and function tool identities", async () => {
  const custom = {
    id: "fc_exec",
    type: "custom_tool_call",
    name: "exec",
    call_id: "call_exec",
    input: "text(1)",
    status: "completed",
  };
  const func = {
    id: "fc_shell",
    type: "function_call",
    name: "shell",
    call_id: "call_shell",
    arguments: '{"cmd":"pwd"}',
    status: "completed",
  };
  const body = {
    id: "resp_tools",
    object: "response",
    status: "completed",
    output: [{ id: "rs_1", type: "reasoning", summary: [], status: "completed" }, custom, func],
  };
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body,
    headers: {},
  });
  const emitted = events(await response.text());
  assert.equal(emitted.filter((event) => event.type === "response.output_item.done").length, 3);
  const added = emitted.filter((event) => event.type === "response.output_item.added");
  assert.equal((added[1].item as Record<string, unknown>).input, "");
  assert.equal((added[2].item as Record<string, unknown>).arguments, "");
  assert.deepEqual(
    emitted.filter((event) => event.type === "response.output_item.done")[1].item,
    custom
  );
  assert.deepEqual(
    emitted.filter((event) => event.type === "response.output_item.done")[2].item,
    func
  );
  assert.equal(
    emitted.some((event) => event.type === "response.custom_tool_call_input.done"),
    true
  );
  assert.equal(
    emitted.some((event) => event.type === "response.function_call_arguments.done"),
    true
  );
  assert.deepEqual(emitted.at(-1)?.response, body);
});

test("failed Responses JSON never becomes response.completed", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body: {
      id: "resp_failed",
      object: "response",
      status: "failed",
      error: { code: "upstream" },
      output: [],
    },
    headers: {},
  });
  const emitted = events(await response.text());
  assert.equal(emitted.at(-1)?.type, "response.failed");
  assert.equal(
    emitted.some((event) => event.type === "response.completed"),
    false
  );
});

test("unrecognized JSON stays JSON rather than fabricated Responses success", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body: { error: { message: "bad upstream" } },
    headers: {},
  });
  assert.equal(response.headers.get("Content-Type"), "application/json");
});

test("chatCore stamps clientRequestedResponsesStream before forcing stream:false", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const source = await readFile(
    join(import.meta.dirname, "../../open-sse/handlers/chatCore.ts"),
    "utf-8"
  );
  const stamp = source.indexOf("clientRequestedResponsesStream = true");
  const force = source.indexOf("(body as Record<string, unknown>).stream = false");
  const wrap = source.indexOf("maybeWrapForcedNonStreamingResponsesJson({");
  assert.ok(stamp !== -1, "must stamp the client-requested stream flag");
  assert.ok(force !== -1, "must still force stream:false for the web_search fallback");
  assert.ok(wrap !== -1, "must wrap the non-streaming JSON return");
  assert.ok(stamp < force, "stamp must happen before stream:false");
  assert.ok(wrap > force, "wrap must happen on the non-streaming return after the force");
});
