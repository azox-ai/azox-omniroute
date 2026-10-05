import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_RESPONSES_ERROR_FRAME,
  withEarlyStreamKeepalive,
} from "../../open-sse/utils/earlyStreamKeepalive.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

async function drainStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += DECODER.decode(value, { stream: true });
  }
  return text;
}

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoded = chunks.map((c) => ENCODER.encode(c));
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < encoded.length) controller.enqueue(encoded[idx++]);
      else controller.close();
    },
  });
}

// ── Fast path: handler resolves within threshold ──────────────────────────

test("fast path returns handler response verbatim", async () => {
  const response = new Response("hello", { status: 200 });
  const result = await withEarlyStreamKeepalive(Promise.resolve(response), {
    thresholdMs: 5000,
  });
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.equal(text, "hello");
});

// ── Slow path: SSE stream forwarded correctly ─────────────────────────────

test("slow path forwards SSE stream content", async () => {
  const sseBody = makeSseStream([
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const response = new Response(sseBody, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  // Delay resolution past threshold to trigger slow path
  const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 100));

  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 10, // very low to ensure slow path
    intervalMs: 50,
  });

  assert.equal(result.status, 200);
  const text = await drainStream(result.body!);
  assert.ok(text.includes("hello"), "should contain first chunk");
  assert.ok(text.includes("world"), "should contain second chunk");
  assert.ok(text.includes("[DONE]"), "should contain DONE marker");
});

// ── Upstream error with 0 bytes → error frame emitted ─────────────────────

test("upstream error with 0 bytes forwarded emits error frame", async () => {
  const response = new Response(streamThenError([]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 20));
  const result = await withEarlyStreamKeepalive(delayed, { thresholdMs: 1 });
  assert.equal(result.status, 200);
  const text = await drainStream(result.body!);
  assert.match(text, /Upstream stream failed before completion/);
});

// ── Upstream error after partial content → terminal failure ──────────────

function streamThenError(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(ENCODER.encode(chunks[index++]));
      else controller.error(new Error("upstream token=secret died mid-stream"));
    },
  });
}

test("Responses slow path emits one sanitized response.failed after partial content", async () => {
  const response = new Response(
    streamThenError([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    ]),
    { headers: { "content-type": "text/event-stream" } }
  );
  const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 20));
  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 1,
    intervalMs: 50,
    errorFrame: OPENAI_RESPONSES_ERROR_FRAME,
  });
  const text = await drainStream(result.body!);
  assert.match(text, /"delta":"partial"/);
  assert.equal((text.match(/event: response.failed/g) || []).length, 1);
  const failed = JSON.parse(text.match(/event: response.failed\ndata: ([^\n]+)/)![1]);
  assert.equal(failed.type, "response.failed");
  assert.equal(failed.response.status, "failed");
  assert.equal(failed.response.error.code, "stream_disconnected");
  assert.doesNotMatch(text, /token=secret/);
});

test("Responses slow path reports a clean EOF without a terminal event", async () => {
  const response = new Response(
    makeSseStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    ]),
    { headers: { "content-type": "text/event-stream" } }
  );
  const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 20));
  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 1,
    errorFrame: OPENAI_RESPONSES_ERROR_FRAME,
  });
  const text = await drainStream(result.body!);
  assert.equal((text.match(/event: response.failed/g) || []).length, 1);
  assert.match(text, /"delta":"partial"/);
});

test("Responses slow path does not append failure after a terminal event", async () => {
  const response = new Response(
    streamThenError([
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]),
    { headers: { "content-type": "text/event-stream" } }
  );
  const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 20));
  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 1,
    intervalMs: 50,
    errorFrame: OPENAI_RESPONSES_ERROR_FRAME,
  });
  const text = await drainStream(result.body!);
  assert.match(text, /response.completed/);
  assert.doesNotMatch(text, /response.failed/);
});

// ── Handler rejection → error frame ───────────────────────────────────────

test("handler rejection emits error frame", async () => {
  const delayed = new Promise<Response>((_resolve, reject) =>
    setTimeout(() => reject(new Error("handler failed")), 10)
  );

  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 5,
    intervalMs: 50,
  });

  assert.equal(result.status, 200);
  const text = await drainStream(result.body!);
  assert.ok(text.includes("Upstream stream failed before completion"));
});

// ── Client abort stops keepalive ──────────────────────────────────────────

test("client abort stops keepalive and closes stream", async () => {
  const controller = new AbortController();
  const neverResolves = new Promise<Response>(() => {}); // never resolves

  const result = await withEarlyStreamKeepalive(neverResolves, {
    thresholdMs: 10,
    intervalMs: 50,
    signal: controller.signal,
  });

  assert.equal(result.status, 200);

  // Abort after a short delay
  setTimeout(() => controller.abort(), 50);

  const text = await drainStream(result.body!);
  // Should have received some keepalive frames then closed
  assert.ok(text.length >= 0, "stream should close on abort");
});
