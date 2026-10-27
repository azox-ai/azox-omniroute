import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_RESPONSES_ERROR_FRAME,
  withEarlyStreamKeepalive,
} from "../../open-sse/utils/earlyStreamKeepalive.ts";

const encoder = new TextEncoder();

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

for (const fail of [false, true]) {
  test(`Responses slow path appends sanitized terminal failure on ${fail ? "read error" : "EOF"}`, async () => {
    const partial =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    const text = await forward([partial], fail);
    assert.ok(text.includes(partial));
    assert.equal((text.match(/event: response.failed/g) || []).length, 1);
    const failure = JSON.parse(text.match(/event: response.failed\ndata: ([^\n]+)/)![1]);
    assert.equal(failure.response.status, "failed");
    assert.equal(failure.response.error.code, "stream_disconnected");
    assert.equal(typeof failure.response.id, "string");
    assert.equal(typeof failure.sequence_number, "number");
    assert.doesNotMatch(text, /synthetic private error detail/);
  });
}

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
