import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// A synchronous lookup can emit the socket's connect error before Undici installs
// its listener. Keep the real connection in a subprocess: that regression kills
// the process even after fetch has rejected, so assert.rejects alone misses it.
test("a pinned TCP connect error rejects fetch without an unhandled socket error", () => {
  const moduleUrl = new URL("../../src/shared/network/dnsPinnedFetch.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       const { createPinnedFetch } = await import(process.env.PINNED_FETCH_MODULE);
       // IPv4 limited broadcast can never be a TCP peer. On Linux this fails
       // during connect, reproducing the lookup-listener race without real DNS.
       await assert.rejects(
         createPinnedFetch("255.255.255.255", 4)("https://pinned.invalid/", {
           signal: AbortSignal.timeout(3000),
         }),
         { message: "fetch failed" }
       );
       console.log("PINNED_CONNECT_REJECTED");`,
    ],
    {
      env: { ...process.env, PINNED_FETCH_MODULE: moduleUrl },
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /PINNED_CONNECT_REJECTED/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});
