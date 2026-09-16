import test from "node:test";
import assert from "node:assert/strict";

const { applyFingerprint, stripInternalBodyFields } =
  await import("../../open-sse/config/cliFingerprints.ts");
const { CLAUDE_VISIBLE_REASONING_MARKER } =
  await import("../../open-sse/config/internalRequestMarkers.ts");

test("Codex CLI fingerprint orders prompt_cache_key before include", () => {
  const body = {
    model: "gpt-5.5-low",
    stream: true,
    input: [{ role: "user", content: "hello" }],
    instructions: "You are Codex.",
    store: false,
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "auto",
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "conv-codex",
    service_tier: "priority",
  };

  const result = applyFingerprint("codex", {}, body);
  const orderedKeys = Object.keys(JSON.parse(result.bodyString));

  assert.deepEqual(orderedKeys.slice(0, 10), [
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "reasoning",
    "prompt_cache_key",
    "tools",
    "tool_choice",
    "include",
  ]);
});

test("live Claude reasoning marker survives translation but is stripped before serialization", () => {
  const body = {
    thinking: { type: "adaptive" },
    [CLAUDE_VISIBLE_REASONING_MARKER]: true,
  };

  stripInternalBodyFields(body, { preserveClaudeVisibleReasoning: true });
  assert.equal(body[CLAUDE_VISIBLE_REASONING_MARKER], true);

  stripInternalBodyFields(body);
  assert.equal(body[CLAUDE_VISIBLE_REASONING_MARKER], undefined);
  assert.deepEqual(body.thinking, { type: "adaptive" });
});
