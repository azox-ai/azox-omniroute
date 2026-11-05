import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PROFILE_ROUTES,
  lazyServerSource,
  profileBuiltImage,
  summarizeSamples,
} from "../../../scripts/perf/docker-runtime-profile.mjs";

test("runtime smoke only targets existing dashboard pages and API routes", () => {
  for (const route of PROFILE_ROUTES) {
    const relative = route.startsWith("/dashboard")
      ? `src/app/(dashboard)${route}/page.tsx`
      : `src/app${route}/route.ts`;
    assert.ok(fs.existsSync(path.resolve(relative)), `Missing route: ${route}`);
  }
});

test("built-image smoke requires an explicit image", async () => {
  await assert.rejects(profileBuiltImage(), /Expected image/);
});

test("runtime A/B changes only the generated preload flag", () => {
  const source = 'const config = {"preloadEntriesOnStart":true,"requireApiKey":true};';
  assert.equal(
    lazyServerSource(source),
    'const config = {"preloadEntriesOnStart":false,"requireApiKey":true};'
  );
});

test("runtime A/B rejects missing or ambiguous generated preload flags", () => {
  for (const source of [
    "",
    '"preloadEntriesOnStart":false',
    '"preloadEntriesOnStart":true,"preloadEntriesOnStart":true',
  ]) {
    assert.throws(() => lazyServerSource(source), /Expected one generated preload setting/);
  }
});

test("runtime sample summary handles phases shorter than sampling interval", () => {
  assert.deepEqual(summarizeSamples([]), {
    count: 0,
    peakCurrentBytes: null,
    peakAnonBytes: null,
    final: null,
  });
  const samples = [
    { current: 100, anon: 80 },
    { current: 95, anon: 85 },
  ];
  assert.deepEqual(summarizeSamples(samples), {
    count: 2,
    peakCurrentBytes: 100,
    peakAnonBytes: 85,
    final: samples[1],
  });
});
