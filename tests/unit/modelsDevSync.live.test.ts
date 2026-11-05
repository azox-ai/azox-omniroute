/**
 * Live models.dev API checks (opt-in network test).
 *
 * Runs only with OMNIROUTE_LIVE_NETWORK_TESTS=1 so offline / sandboxed CI stays
 * deterministic. The offline contract of fetchModelsDev lives in modelsDevSync.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchModelsDev } from "../../src/lib/modelsDevSync.ts";

const LIVE = process.env.OMNIROUTE_LIVE_NETWORK_TESTS === "1";

describe(
  "modelsDevSync — fetchModelsDev (live API)",
  { skip: LIVE ? false : "set OMNIROUTE_LIVE_NETWORK_TESTS=1 to hit models.dev" },
  () => {
    it("fetches data from models.dev API", async () => {
      const data = await fetchModelsDev();
      assert.ok(typeof data === "object", "data should be an object");

      const providerCount = Object.keys(data).length;
      assert.ok(providerCount >= 100, `should have 100+ providers, got ${providerCount}`);

      let modelCount = 0;
      for (const provider of Object.values(data)) {
        if (provider.models) modelCount += Object.keys(provider.models).length;
      }
      assert.ok(modelCount >= 4000, `should have 4000+ models, got ${modelCount}`);
    });

    it("returns cached data on second call", async () => {
      const data1 = await fetchModelsDev();
      const data2 = await fetchModelsDev();
      assert.strictEqual(data1, data2, "should return same cached reference");
    });

    it("has openai provider with gpt-4o model", async () => {
      const data = await fetchModelsDev();
      assert.ok(data.openai, "openai provider should exist");
      assert.ok(data.openai.models["gpt-4o"], "gpt-4o model should exist");
    });

    it("has anthropic provider with claude models", async () => {
      const data = await fetchModelsDev();
      assert.ok(data.anthropic, "anthropic provider should exist");
      const claudeModels = Object.keys(data.anthropic.models).filter((m) => m.includes("claude"));
      assert.ok(claudeModels.length > 0, "should have claude models");
    });
  }
);
