import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { withEarlyStreamKeepalive } from "../../open-sse/utils/earlyStreamKeepalive.ts";

/**
 * #8140: Verify the keepalive interval is cleaned up after disconnect/completion.
 *
 * The keepalive interval is unref'd, so it never shows in process._getActiveHandles(),
 * and that process-wide count also moves with unrelated handles (a MessagePort closing).
 * Track the intervals the stream itself creates and clears instead.
 */

function trackIntervals(t: TestContext): () => number {
  const live = new Set<unknown>();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", ((...args: Parameters<typeof setInterval>) => {
    const handle = realSet(...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval);
  t.mock.method(globalThis, "clearInterval", ((handle?: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle);
    realClear(handle);
  }) as typeof clearInterval);
  return () => live.size;
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("#8140: keepalive interval is cleared after client disconnect", async (t) => {
  const liveIntervals = trackIntervals(t);
  const controller = new AbortController();
  const result = await withEarlyStreamKeepalive(new Promise<Response>(() => {}), {
    thresholdMs: 5,
    intervalMs: 15,
    signal: controller.signal,
  });

  const reader = result.body!.getReader();
  assert.equal(liveIntervals(), 1, "slow path should start one keepalive interval");
  const { value } = await reader.read();
  assert.ok(value && value.byteLength > 0, "should emit at least one keepalive frame");

  controller.abort();

  // Drain until closed.
  const drained = (async () => {
    while (true) {
      const { done } = await reader.read();
      if (done) return true;
    }
  })();
  const timed = new Promise<boolean>((r) => setTimeout(() => r(false), 2000));
  assert.equal(await Promise.race([drained, timed]), true, "stream should close after abort");

  assert.equal(liveIntervals(), 0, "keepalive interval should be cleared after disconnect");
});

test("#8140: keepalive interval is cleared after handler resolves (slow path)", async (t) => {
  const liveIntervals = trackIntervals(t);
  const slowHandler = new Promise<Response>((resolve) => {
    setTimeout(() => resolve(sseResponse("data: [DONE]\n\n")), 80);
  });

  const result = await withEarlyStreamKeepalive(slowHandler, {
    thresholdMs: 10,
    intervalMs: 15,
  });

  const reader = result.body!.getReader();
  assert.equal(liveIntervals(), 1, "slow path should start one keepalive interval");
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }

  assert.equal(liveIntervals(), 0, "keepalive interval should be cleared after normal completion");
});

test("#8140: keepalive interval is cleared after handler rejects (slow path)", async (t) => {
  const liveIntervals = trackIntervals(t);
  const slowFail = new Promise<Response>((_, reject) => {
    setTimeout(() => reject(new Error("upstream died")), 80);
  });

  const result = await withEarlyStreamKeepalive(slowFail, {
    thresholdMs: 10,
    intervalMs: 15,
  });

  const reader = result.body!.getReader();
  assert.equal(liveIntervals(), 1, "slow path should start one keepalive interval");
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }

  assert.equal(liveIntervals(), 0, "keepalive interval should be cleared after error completion");
});
