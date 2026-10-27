import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyServerOwnedToolLoopIfNeeded,
  derivePostInjectionRequestIdentity,
} from "../../open-sse/handlers/chatCore/serverOwnedToolLoopWire.ts";
import type {
  NonStreamingProviderLegResult,
  ProviderLegReceipt,
} from "../../src/lib/skills/toolLoopTypes.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

function receipt(index: number): ProviderLegReceipt {
  return {
    index,
    connectionId: "conn-1",
    provider: "openai",
    model: "gpt-4o",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    latencyMs: 10,
    httpStatus: 200,
    errorType: null,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    serviceTier: null,
    computedCostUsd: 0.01,
    toolCalls: [],
    termination: "completed",
    clientVisible: true,
  };
}

function okLeg(overrides: Partial<NonStreamingProviderLegResult & { kind: "ok" }> = {}) {
  return {
    kind: "ok" as const,
    response: {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "memory_search", arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    responseForMemoryExtraction: {},
    providerBody: {},
    providerRequest: {},
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    responsePayloadFormat: "openai",
    looksLikeSSE: false,
    connectionId: "conn-1",
    headers: new Headers(),
    receipt: receipt(0),
    ...overrides,
  };
}

test("Responses web search executes server-side and returns final model answer", async () => {
  let nextBody: Record<string, unknown> | undefined;
  const call = {
    type: "function_call",
    call_id: "call_search",
    name: "omniroute_web_search",
    arguments: '{"query":"docs"}',
  };
  const leg = okLeg({ response: { output: [call] }, responsePayloadFormat: "openai-responses" });
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: true,
    stream: false,
    isResponsesEndpoint: true,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    responsesWebSearchFallback: true,
    initialLeg: leg,
    sourceBody: { input: "find docs", tools: [{ type: "function", name: "omniroute_web_search" }] },
    skillsModelId: "openai",
    executionContext: {
      apiKeyId: "test",
      sessionId: "test",
      requestId: "test",
      builtinToolNames: ["omniroute_web_search"],
      customSkillExecutionEnabled: false,
    },
    expectedConnectionId: "conn-1",
    executeServerOwned: async () => [
      {
        id: "call_search",
        name: "omniroute_web_search",
        result: {
          success: true,
          query: "docs",
          results: [{ title: "Docs", url: "https://example.com" }],
        },
        replayed: false,
      },
    ],
    followUpLeg: async (body) => {
      nextBody = body;
      return okLeg({
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "Found docs" }] }],
        },
      });
    },
    logReceipt: () => {},
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.loop.followUps, 1);
  const output = result.leg.response.output as Array<{
    type: string;
    action?: { query: string };
    content?: Array<{ text: string }>;
  }>;
  assert.deepEqual(
    output.map((item) => item.type),
    ["web_search_call", "message"]
  );
  assert.equal(output[0].action?.query, "docs");
  assert.deepEqual(output[1].content?.[0].text, "Found docs");
  assert.equal(
    (nextBody?.input as Array<{ type: string }>).filter(
      (item) => item.type === "function_call_output"
    ).length,
    1
  );
});

test("Responses repeated search retains native items at follow-up boundary", async () => {
  const call = {
    type: "function_call",
    call_id: "call_search",
    name: "omniroute_web_search",
    arguments: '{"query":"docs"}',
  };
  const leg = okLeg({ response: { output: [call] }, responsePayloadFormat: "openai-responses" });
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: true,
    stream: false,
    isResponsesEndpoint: true,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    responsesWebSearchFallback: true,
    initialLeg: leg,
    sourceBody: { input: "find docs" },
    skillsModelId: "openai",
    executionContext: {
      apiKeyId: "test",
      sessionId: "test",
      requestId: "test",
      builtinToolNames: ["omniroute_web_search"],
    },
    executeServerOwned: async () => [
      {
        id: "call_search",
        name: "omniroute_web_search",
        result: { success: true, query: "docs", results: [] },
        replayed: false,
      },
    ],
    followUpLeg: async () => leg,
    logReceipt: () => {},
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.loop.termination, "max_followups");
  const output = result.leg.response.output as Array<Record<string, unknown>>;
  assert.ok(output.some((item) => item.type === "web_search_call"));
  assert.ok(output.some((item) => item.type === "function_call_output"));
});

test("flag-off skips the loop and does not resume", async () => {
  let followUps = 0;
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: false,
    stream: false,
    isResponsesEndpoint: false,
    sourceFormat: FORMATS.OPENAI,
    initialLeg: okLeg(),
    sourceBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    skillsModelId: "openai",
    executionContext: {
      apiKeyId: "k",
      sessionId: "s",
      requestId: "r",
      builtinToolNames: ["memory_search"],
    },
    expectedConnectionId: "conn-1",
    followUpLeg: async () => {
      followUps += 1;
      throw new Error("must not resume");
    },
    logReceipt: () => {},
  });
  assert.equal(result.kind, "skip");
  assert.equal(followUps, 0);
});

test("Responses format skips even when enabled", async () => {
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: true,
    stream: false,
    isResponsesEndpoint: true,
    sourceFormat: FORMATS.OPENAI,
    initialLeg: okLeg(),
    sourceBody: { model: "gpt-4o", messages: [] },
    skillsModelId: "openai",
    executionContext: { apiKeyId: "k", sessionId: "s", requestId: "r" },
    expectedConnectionId: "conn-1",
    followUpLeg: async () => {
      throw new Error("must not resume");
    },
    logReceipt: () => {},
  });
  assert.equal(result.kind, "skip");
});

test("enabled Chat loop resumes once and logs receipts", async () => {
  const logged: number[] = [];
  let followUps = 0;
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: true,
    stream: false,
    isResponsesEndpoint: false,
    sourceFormat: FORMATS.OPENAI,
    initialLeg: okLeg(),
    sourceBody: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    },
    skillsModelId: "openai",
    executionContext: {
      apiKeyId: "k",
      sessionId: "s",
      requestId: "r",
      builtinToolNames: ["memory_search"],
    },
    expectedConnectionId: "conn-1",
    followUpLeg: async () => {
      followUps += 1;
      return {
        kind: "ok",
        response: {
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        },
        responseForMemoryExtraction: { text: "done" },
        providerBody: { id: "2" },
        providerRequest: { messages: [] },
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        responsePayloadFormat: "openai",
        looksLikeSSE: false,
        connectionId: "conn-1",
        headers: new Headers(),
        receipt: receipt(1),
      };
    },
    logReceipt: (r) => logged.push(r.index),
    executeServerOwned: async (calls) =>
      calls.map((c) => ({ id: c.id, name: c.name, result: { hits: [] }, replayed: false })),
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(followUps, 1);
  assert.deepEqual(logged, [0, 1]);
  assert.equal(
    (result.leg.response as { choices: Array<{ message: { content: string } }> }).choices[0].message
      .content,
    "done"
  );
  assert.equal(result.usage?.prompt_tokens, 14);
});

test("provider error from follow-up is returned as error", async () => {
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: true,
    stream: false,
    isResponsesEndpoint: false,
    sourceFormat: FORMATS.OPENAI,
    initialLeg: okLeg(),
    sourceBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    skillsModelId: "openai",
    executionContext: {
      apiKeyId: "k",
      sessionId: "s",
      requestId: "r",
      builtinToolNames: ["memory_search"],
    },
    expectedConnectionId: "conn-1",
    followUpLeg: async () => ({
      kind: "error",
      result: {
        success: false,
        status: 429,
        response: new Response(null, { status: 429 }),
        error: "rate limited",
        errorCode: "rate_limited",
      },
      receipt: receipt(1),
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    }),
    logReceipt: () => {},
    executeServerOwned: async (calls) =>
      calls.map((c) => ({ id: c.id, name: c.name, result: { hits: [] }, replayed: false })),
  });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.loop.errorResult?.status, 429);
});

test("derivePostInjectionRequestIdentity uses the client idempotency header", () => {
  const a = derivePostInjectionRequestIdentity({
    apiKeyId: "k",
    headers: { "idempotency-key": "tool-loop-retry-1" },
    skillRequestId: "internal-1",
    postInjectionBody: { messages: [{ role: "user", content: "hi" }] },
  });
  const b = derivePostInjectionRequestIdentity({
    apiKeyId: "k",
    headers: { "idempotency-key": "tool-loop-retry-1" },
    skillRequestId: "internal-2",
    postInjectionBody: { messages: [{ role: "user", content: "hi" }] },
  });
  const c = derivePostInjectionRequestIdentity({
    apiKeyId: "k",
    headers: { "idempotency-key": "other" },
    skillRequestId: "internal-1",
    postInjectionBody: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("applyServerOwnedToolLoopIfNeeded accepts undefined expectedConnectionId for unmanaged leases", async () => {
  const result = await applyServerOwnedToolLoopIfNeeded({
    enabled: false,
    stream: false,
    isResponsesEndpoint: false,
    sourceFormat: FORMATS.OPENAI,
    initialLeg: okLeg(),
    sourceBody: { model: "gpt-4o", messages: [] },
    skillsModelId: "openai",
    executionContext: { apiKeyId: "k", sessionId: "s", requestId: "r" },
    expectedConnectionId: undefined,
    followUpLeg: async () => {
      throw new Error("must not resume");
    },
    logReceipt: () => {},
  });
  assert.equal(result.kind, "skip");
});
