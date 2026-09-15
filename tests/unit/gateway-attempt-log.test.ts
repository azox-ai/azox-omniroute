import assert from "node:assert/strict";
import test from "node:test";

import { buildGatewayAttemptLog } from "../../open-sse/handlers/chatCore/gatewayAttemptLog.ts";

test("builds bounded OmniRoute attempt metadata for Loki", () => {
  const event = buildGatewayAttemptLog(
    {
      correlationId: "trace-123\nignored",
      clientHeaders: {
        "X-Llm-Key-Alias": "zbs-coding-tech-quanlt",
        "x-llm-team-alias": "ZBS Tech - Code",
      },
      comboName: "omniroute-combo",
      comboStepId: "step-2",
      provider: "claude",
      model: "claude-opus-5",
      accountAlias: "claude-subscription-1",
      credentials: { connectionId: "connection-id", accessToken: "never-log-me" },
      connectionId: "connection-id",
      status: 429,
      error: "rate limited",
      startTime: 1_000,
    },
    1_718
  );

  assert.deepEqual(event, {
    event: "llm_gateway.router_attempt",
    router: "omniroute",
    correlation_id: "trace-123ignored",
    key_alias: "zbs-coding-tech-quanlt",
    team_alias: "ZBS Tech - Code",
    combo: "omniroute-combo",
    attempt: "step-2",
    provider: "claude",
    model: "claude-opus-5",
    account: "claude-subscription-1",
    status: 429,
    outcome: "failure",
    latency_ms: 718,
  });
  assert.equal(JSON.stringify(event).includes("never-log-me"), false);
});

test("falls back to the incoming correlation header and records success", () => {
  const event = buildGatewayAttemptLog(
    {
      clientHeaders: new Headers({ "X-Correlation-Id": "trace-from-header" }),
      provider: "codex",
      model: "gpt-5.6",
      credentials: { connectionId: "codex-account" },
      status: 200,
      startTime: 5,
    },
    25
  );

  assert.equal(event.correlation_id, "trace-from-header");
  assert.equal(event.account, "codex-account");
  assert.equal(event.outcome, "success");
  assert.equal(event.latency_ms, 20);
});
