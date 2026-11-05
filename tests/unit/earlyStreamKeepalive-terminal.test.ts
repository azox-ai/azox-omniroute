import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_RESPONSES_ERROR_FRAME,
  withEarlyStreamKeepalive,
} from "../../open-sse/utils/earlyStreamKeepalive.ts";

const encoder = new TextEncoder();

for (const terminal of ["response.completed", "response.failed", "response.incomplete"]) {
  for (const header of [true, false]) {
    test(`Responses large ${terminal} preserves terminal detection (header=${header})`, async () => {
      const event = `${header ? `event: ${terminal}\r\n` : ""}data: ${JSON.stringify({
        type: terminal,
        response: { output: "x".repeat(100_000) },
      })}\r\n\r\n`;
      const chunks: string[] = [];
      for (let offset = 0; offset < event.length; offset += 4093)
        chunks.push(event.slice(offset, offset + 4093));
      const text = await forward(chunks, false);
      assert.ok(text.includes(event));
      assert.doesNotMatch(text, /stream_disconnected/);
      assert.equal(
        (text.match(/"type":"response.failed"/g) || []).length,
        terminal === "response.failed" ? 1 : 0
      );
    });
  }
}

test("Responses large nonterminal event still requires a terminal", async () => {
  const event = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(100_000) })}\n\n`;
  const text = await forward([event.slice(0, 70_000), event.slice(70_000)], false);
  assert.ok(text.includes(event));
  assert.match(text, /stream_disconnected/);
});

test("Responses oversized truncated terminal is not mistaken for completed", async () => {
  const event = `event: response.completed\ndata: {"type":"response.completed","output":"${"x".repeat(100_000)}`;
  const text = await forward([event.slice(0, 70_000), event.slice(70_000)], false);
  assert.ok(text.includes(event));
  assertTerminalFailure(text, "no_terminal");
});

function assertTerminalFailure(text: string, reason: "abort" | "no_terminal"): void {
  const events = text.split(/\r?\n\r?\n/).filter(Boolean);
  const terminal = events.at(-1)!;
  assert.match(terminal, /^event: response.failed\ndata: /);
  const failure = JSON.parse(terminal.split("\ndata: ")[1]);
  assert.equal(failure.type, "response.failed");
  assert.equal(failure.response.status, "failed");
  assert.equal(failure.response.error.code, "stream_disconnected");
  assert.match(
    failure.response.error.message,
    reason === "abort" ? /stream aborted/ : /without a terminal event/
  );
  assert.equal(events.filter((event) => event.startsWith("event: response.failed\n")).length, 1);
  assert.doesNotMatch(terminal, /synthetic private error detail/);
}

async function forward(chunks: string[], fail: boolean): Promise<string> {
  let index = 0;
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else if (fail) controller.error(new Error("synthetic private error detail"));
        else controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const response = await withEarlyStreamKeepalive(pending, {
    thresholdMs: 1,
    errorFrame: OPENAI_RESPONSES_ERROR_FRAME,
  });
  resolve(upstream);
  return response.text();
}

test("Responses slow path appends sanitized terminal failure on clean EOF", async () => {
  const partial =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';
  const text = await forward([partial], false);
  assert.ok(text.includes(partial));
  assert.equal((text.match(/event: response.failed/g) || []).length, 1);
  const failure = JSON.parse(text.match(/event: response.failed\ndata: ([^\n]+)/)![1]);
  assert.equal(failure.response.status, "failed");
  assert.equal(failure.response.error.code, "stream_disconnected");
  assert.equal(typeof failure.response.id, "string");
  assert.equal(typeof failure.sequence_number, "number");
});

for (const fail of [false, true]) {
  test(`Responses mid-frame ${fail ? "read error" : "EOF"} emits a valid terminal`, async () => {
    const complete = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    const truncated =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"cut';
    const text = await forward([complete, truncated], fail);
    assert.ok(text.includes(complete + truncated));
    assert.match(text, /"delta":"partial"/);
    assertTerminalFailure(text, fail ? "abort" : "no_terminal");
    assert.doesNotMatch(text, /synthetic private error detail/);
  });
}

test("Responses read error before upstream bytes emits a sanitized terminal", async () => {
  const text = await forward([], true);
  assertTerminalFailure(text, "abort");
});

for (const terminal of ["response.completed", "response.failed", "response.incomplete"]) {
  for (const fail of [false, true]) {
    test(`Responses preserves split ${terminal} without another failure (${fail})`, async () => {
      const text = await forward(
        [
          `event: ${terminal}\r\ndata: {"type":"${terminal.slice(0, 10)}`,
          `${terminal.slice(10)}"}\r\n`,
          "\r\n",
        ],
        fail
      );
      assert.equal(
        (text.match(/event: response.failed/g) || []).length,
        terminal === "response.failed" ? 1 : 0
      );
      assert.doesNotMatch(text, /stream_disconnected/);
    });
  }
}
