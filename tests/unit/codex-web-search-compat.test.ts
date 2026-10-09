import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodexTools } from "../../open-sse/executors/codex/tools.ts";

for (const type of ["web_search_preview", "web_search_preview_2025_03_11"]) {
  test(`Codex canonicalizes hosted ${type} without dropping search controls`, () => {
    const tool = {
      type,
      search_context_size: "low",
      filters: { allowed_domains: ["developers.openai.com"] },
      external_web_access: false,
      user_location: { type: "approximate", country: "VN" },
    };
    const original = structuredClone(tool);
    const body = { tools: [tool], tool_choice: { type } };
    normalizeCodexTools(body);
    assert.deepEqual(body.tools, [{ ...original, type: "web_search" }]);
    assert.equal(body.tool_choice.type, "web_search");
  });
}

test("Codex leaves ordinary, custom, namespace and other hosted tools unchanged", () => {
  const tools = [
    { type: "web_search", external_web_access: true },
    { type: "function", name: "web_search", parameters: { type: "object" } },
    { type: "custom", name: "web_search", format: { type: "text" } },
    { type: "image_generation", output_format: "png" },
    { type: "namespace", name: "mcp__probe__", tools: [] },
  ];
  const before = structuredClone(tools);
  const body = { tools };
  normalizeCodexTools(body, { preserveCustomTools: true });
  assert.deepEqual(body.tools, before);
});
