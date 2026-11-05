import test from "node:test";
import assert from "node:assert/strict";

import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.ts";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.ts";
import { extractRequestToolMetadata } from "../../open-sse/handlers/chatCore/requestToolIdentity.ts";

test("Responses search follow-up does not send Claude tool alias ledger to upstream", () => {
  const source = {
    input: [
      { role: "user", content: "Find docs" },
      {
        type: "function_call",
        name: "omniroute_web_search",
        call_id: "call_search",
        arguments: '{"query":"docs"}',
      },
      { type: "function_call_output", call_id: "call_search", output: '{"success":true}' },
    ],
    tools: [
      {
        type: "function",
        name: "omniroute_web_search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  };
  const chat = openaiResponsesToOpenAIRequest("claude-sonnet-5", source, false, {});
  const claude = openaiToClaudeRequest("claude-sonnet-5", chat, false) as Record<string, unknown>;
  assert.ok(claude._toolNameMap instanceof Map);
  const metadata = extractRequestToolMetadata(claude);
  assert.ok(metadata.toolNameAliasMap?.size);
  assert.equal(claude._toolNameMap, undefined);
  assert.equal(claude._namespaceToolIdentityMap, undefined);
});
