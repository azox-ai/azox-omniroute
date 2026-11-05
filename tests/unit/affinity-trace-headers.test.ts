import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { withAffinityTraceHeaders } from "../../src/sse/handlers/chatHelpers.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";

test("affinity trace headers expose a short connection id and a hashed session key", () => {
  const response = new Response("{}", {
    headers: { "X-OmniRoute-Selected-Connection-Id": "0a9cc8ee-3673-4744-821f-46aef9a860e2" },
  });
  const sessionKey = "header:sensitive-session";
  const result = withAffinityTraceHeaders(response, sessionKey, "req-1");

  assert.equal(result.headers.get("x-omniroute-connection-id"), "0a9cc8ee");
  assert.equal(
    result.headers.get("x-omniroute-session-key-hash"),
    createHash("sha256").update(sessionKey).digest("hex").slice(0, 16)
  );
  assert.ok(!result.headers.get("x-omniroute-session-key-hash")?.includes("sensitive"));
});

test("affinity trace headers are omitted when no connection or session key exists", () => {
  const result = withAffinityTraceHeaders(new Response("{}"), null, null);
  assert.equal(result.headers.get("x-omniroute-connection-id"), null);
  assert.equal(result.headers.get("x-omniroute-session-key-hash"), null);
});

test("ninerouter compatible upstream receives only allowlisted trace and affinity headers", () => {
  const executor = new DefaultExecutor("openai-compatible-chat-test");
  const headers = executor.buildHeaders(
    {
      apiKey: "test-key",
      providerSpecificData: { baseUrl: "http://ninerouter:20128/v1" },
    },
    false,
    {
      "X-Session-Id": "session-123",
      "x-request-id": "request-123",
      "x-correlation-id": "correlation-123",
      "x-unrelated": "must-not-forward",
    },
    "cx/gpt-5.5",
    {}
  );

  assert.equal(headers["x-session-id"], "session-123");
  assert.equal(headers["x-request-id"], "request-123");
  assert.equal(headers["x-correlation-id"], "correlation-123");
  assert.equal(headers["x-unrelated"], undefined);
});

test("other compatible upstreams do not receive the internal ninerouter trace headers", () => {
  const executor = new DefaultExecutor("openai-compatible-chat-test");
  const headers = executor.buildHeaders(
    {
      apiKey: "test-key",
      providerSpecificData: { baseUrl: "https://example.com/v1" },
    },
    false,
    {
      "x-codex-session-id": "codex-session-123",
      "x-request-id": "request-123",
      "x-correlation-id": "correlation-123",
    },
    "model",
    {}
  );

  assert.equal(headers["x-codex-session-id"], undefined);
  assert.equal(headers["x-request-id"], undefined);
  assert.equal(headers["x-correlation-id"], undefined);
});
