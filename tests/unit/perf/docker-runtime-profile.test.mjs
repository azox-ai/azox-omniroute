import test from "node:test";
import assert from "node:assert/strict";
import {
  lazyServerSource,
  profileBuiltImage,
  summarizeSamples,
} from "../../../scripts/perf/docker-runtime-profile.mjs";

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
