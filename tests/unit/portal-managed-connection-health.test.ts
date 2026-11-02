import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-portal-guard-"));
process.env.DATA_DIR = dataDir;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const health = await import("../../src/lib/tokenHealthCheck.ts");
const portal = await import("../../src/lib/providers/portalManagedConnection.ts");
const refresh = await import("../../open-sse/services/tokenRefresh.ts");
const breaker = await import("../../open-sse/services/tokenRefresh/circuitBreaker.ts");
health.stopTokenHealthCheck();

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Portal marker requires a nonempty string", () => {
  for (const marker of [null, undefined, "", 17, false]) {
    assert.equal(portal.isPortalManagedConnection({ providerSpecificData: { portalExternalId: marker } }), false);
  }
  assert.equal(portal.isPortalManagedConnection(null), false);
  assert.equal(portal.isPortalManagedConnection({ providerSpecificData: { portalExternalId: "fixture" } }), true);
});

test("A4 recovery clears top-level and nested terminal state without mutating metadata", () => {
  const metadata = {
    portalExternalId: "fixture",
    portalTokenVersion: 7,
    expiredRetry: { count: 3, at: "2026-01-01" },
    refreshCircuit: { until: "2099-01-01" },
    unrelated: { keep: true },
  };
  const update = portal.buildPortalRecoveryUpdate(metadata);
  assert.equal(update.isActive, true);
  assert.equal(update.testStatus, "active");
  for (const field of ["lastError", "lastErrorAt", "lastErrorType", "lastErrorSource", "errorCode", "expiredRetryCount", "expiredRetryAt", "rateLimitedUntil"]) {
    assert.equal(update[field as keyof typeof update], null, field);
  }
  assert.equal(update.backoffLevel, 0);
  assert.deepEqual(update.providerSpecificData, {
    portalExternalId: "fixture", portalTokenVersion: 7, unrelated: { keep: true },
  });
  assert.ok(metadata.expiredRetry);
  assert.ok(metadata.refreshCircuit);
});

test("A4 runtime recovery resets only the selected connection circuit", async (context) => {
  const provider = "portal-fixture";
  context.after(() => {
    for (const connectionId of ["portal", "direct"]) {
      portal.resetPortalRefreshCircuit(provider, connectionId);
    }
  });
  for (const connectionId of ["portal", "direct"]) {
    await breaker.refreshWithRetry(async () => null, 1, null, provider, {
      scope: "connection", connectionId, failureThreshold: 1,
    });
  }
  portal.resetPortalRefreshCircuit(provider, "portal");
  assert.equal(breaker.isProviderBlocked(provider, { scope: "connection", connectionId: "portal" }), false);
  assert.equal(breaker.isProviderBlocked(provider, { scope: "connection", connectionId: "direct" }), true);
});

test("A5 repeated expired Portal sweeps leave the entire persisted row unchanged", async () => {
  for (const provider of ["claude", "codex", "antigravity"]) {
    const connection = await providers.createProviderConnection({
      provider, authType: "oauth", name: `Portal fixture ${provider}`,
      accessToken: "fixture-access", refreshToken: null,
      expiresAt: "2020-01-01T00:00:00.000Z", testStatus: "active", isActive: true,
      providerSpecificData: { portalExternalId: `fixture-${provider}` },
    });
    const before = await providers.getProviderConnectionById(String(connection.id));
    for (let sweep = 0; sweep < 5; sweep++) await health.checkConnection(connection);
    assert.deepEqual(await providers.getProviderConnectionById(String(connection.id)), before);
  }
});

test("A5 reactive Portal refresh never calls fetch or persist, even with a stale refresh token", async (context) => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  let writes = 0;
  const result = await refresh.getAccessToken("claude", {
    refreshToken: "fixture-stale-refresh",
    providerSpecificData: { portalExternalId: "fixture" },
  }, null, null, async () => { writes++; });
  assert.equal(result, refresh.NO_REFRESH_NEEDED);
  assert.equal(calls, 0);
  assert.equal(writes, 0);
});

test("A5 reactive refresh rechecks the persisted Portal marker when credentials omit it", async (context) => {
  const connection = await providers.createProviderConnection({
    provider: "claude", authType: "oauth", name: "Persisted Portal fixture",
    accessToken: "fixture-access", refreshToken: "fixture-unused-refresh",
    expiresAt: "2020-01-01T00:00:00.000Z", testStatus: "active", isActive: true,
    providerSpecificData: { portalExternalId: "persisted-marker" },
  });
  const before = await providers.getProviderConnectionById(String(connection.id));
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  const result = await refresh.getAccessToken("claude", {
    connectionId: String(connection.id), refreshToken: "fixture-unused-refresh",
  }, null, null, async () => { throw new Error("unexpected persist"); });
  assert.equal(result, refresh.NO_REFRESH_NEEDED);
  assert.equal(calls, 0);
  assert.deepEqual(await providers.getProviderConnectionById(String(connection.id)), before);
});

test("A5 manual test returns an error without refreshing or condemning a Portal row", async (context) => {
  const { testOAuthConnection, testSingleConnection } =
    await import("../../src/app/api/providers/[id]/test/route.ts");
  const connection = await providers.createProviderConnection({
    provider: "codex", authType: "oauth", name: "Manual Portal fixture",
    accessToken: "fixture-access", refreshToken: "fixture-manual-refresh",
    expiresAt: "2020-01-01T00:00:00.000Z", testStatus: "active", isActive: true,
    providerSpecificData: { portalExternalId: "manual-marker" },
  });
  const before = await providers.getProviderConnectionById(String(connection.id));
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  for (const result of [
    await testOAuthConnection(connection),
    await testSingleConnection(String(connection.id)),
  ]) {
    assert.equal(result.valid, false);
    assert.equal(result.skipped, true);
    assert.equal(result.refreshed, false);
    assert.equal(result.diagnosis?.code, "portal_managed");
  }
  assert.equal(calls, 0);
  assert.deepEqual(await providers.getProviderConnectionById(String(connection.id)), before);
});

test("Portal refresh skips do not count as provider-wide breaker failures", async (context) => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  const before = breaker.getCircuitBreakerStatus().claude;
  assert.equal(before, undefined);
  for (let attempt = 0; attempt < 7; attempt++) {
    const result = await breaker.refreshWithRetry(() => refresh.getAccessToken("claude", {
      refreshToken: "fixture-skipped-refresh",
      providerSpecificData: { portalExternalId: "fixture-breaker" },
    }, null), 1, null, "claude");
    assert.equal(result, null);
    assert.deepEqual(breaker.getCircuitBreakerStatus().claude, before);
    assert.equal(breaker.isProviderBlocked("claude"), false);
  }
  assert.equal(calls, 0);
});

test("Codex executor Portal skips with no refresh token leave the provider breaker and row unchanged", async (context) => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const executor = new CodexExecutor();
  const connection = await providers.createProviderConnection({
    provider: "codex", authType: "oauth", name: "Codex Portal executor fixture",
    accessToken: "fixture-codex-access", refreshToken: null,
    expiresAt: "2020-01-01T00:00:00.000Z", testStatus: "active", isActive: true,
    providerSpecificData: { portalExternalId: "codex-executor-marker" },
  });
  const connectionId = String(connection.id);
  const before = await providers.getProviderConnectionById(connectionId);
  const credentials = {
    connectionId, accessToken: "fixture-codex-access", refreshToken: null,
    providerSpecificData: { portalExternalId: "codex-executor-marker" },
  };
  const beforeCredentials = structuredClone(credentials);
  const beforeBreaker = breaker.getCircuitBreakerStatus().codex;
  assert.equal(beforeBreaker, undefined);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let writes = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  for (let attempt = 0; attempt < 7; attempt++) {
    let refreshCalls = 0;
    const result = await breaker.refreshWithRetry(() => {
      refreshCalls++;
      return refresh.runWithOnPersist(async () => { writes++; }, () =>
        executor.refreshCredentials(credentials, null));
    }, 3, null, "codex", { scope: "provider", failureThreshold: 5 });
    assert.equal(result, null);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(breaker.getCircuitBreakerStatus().codex, beforeBreaker);
    assert.equal(breaker.isProviderBlocked("codex"), false);
  }
  assert.equal(calls, 0);
  assert.equal(writes, 0);
  assert.deepEqual(credentials, beforeCredentials);
  assert.deepEqual(await providers.getProviderConnectionById(connectionId), before);
});

test("Codex executor direct-login without a refresh token still records failure and can refresh with a token", async (context) => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const executor = new CodexExecutor();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "fixture-codex-renewed", expires_in: 3600 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  const result = await breaker.refreshWithRetry(() => executor.refreshCredentials({
    refreshToken: null, providerSpecificData: {},
  }, null), 1, null, "codex", { scope: "provider", failureThreshold: 5 });
  assert.equal(result, null);
  assert.equal(calls, 0);
  assert.equal(breaker.getCircuitBreakerStatus().codex.failures, 1);
  assert.equal(breaker.isProviderBlocked("codex"), false);
  const renewed = await breaker.refreshWithRetry(() => executor.refreshCredentials({
    refreshToken: "fixture-codex-direct-refresh", providerSpecificData: {},
  }, null), 1, null, "codex", { scope: "provider", failureThreshold: 5 });
  assert.equal(renewed?.accessToken, "fixture-codex-renewed");
  assert.equal(calls, 1);
  assert.equal(breaker.getCircuitBreakerStatus().codex?.failures ?? 0, 0);
});

test("credential scheduler skips Portal without caching an error or blocking dispatch", async (context) => {
  const scheduler = await import("../../src/lib/credentialHealth/scheduler.ts");
  scheduler.stopCredentialHealthCheck();
  const cache = await import("../../src/lib/credentialHealth/cache.ts");
  const { checkCredentialGate } = await import("../../open-sse/services/credentialGate.ts");
  scheduler.__test_resetCredentialHealthScheduler();
  cache.__test_resetCredentialHealthCache();
  context.after(() => {
    scheduler.stopCredentialHealthCheck();
    scheduler.__test_resetCredentialHealthScheduler();
    cache.__test_resetCredentialHealthCache();
  });
  for (const row of await providers.getProviderConnections()) {
    await providers.updateProviderConnection(String(row.id), { healthCheckInterval: 0 });
  }
  const connection = await providers.createProviderConnection({
    provider: "claude", authType: "oauth", name: "Scheduler Portal fixture",
    email: "scheduler-portal@example.invalid", accessToken: "fixture-access", refreshToken: null,
    expiresAt: "2020-01-01T00:00:00.000Z", testStatus: "active", isActive: true,
    healthCheckInterval: 1, providerSpecificData: { portalExternalId: "scheduler-marker" },
  });
  const connectionId = String(connection.id);
  const before = await providers.getProviderConnectionById(connectionId);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  for (let attempt = 0; attempt < 3; attempt++) {
    await scheduler.forceSweep();
    assert.equal(cache.getCredentialHealth(connectionId), undefined);
    assert.notEqual(checkCredentialGate(connectionId, "claude", "claude/fixture").allowed, false);
  }
  assert.deepEqual(await providers.getProviderConnectionById(connectionId), before);
  assert.equal(calls, 0);
});

test("A6 direct-login OAuth still calls its refresh endpoint", async (context) => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "fixture-new-access", expires_in: 3600 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = previousFetch; });
  const result = await refresh.getAccessToken("codex", {
    refreshToken: "fixture-direct-refresh", providerSpecificData: {},
  }, null);
  assert.equal(result?.accessToken, "fixture-new-access");
  assert.equal(calls, 1);
});

test("A6 direct-login with missing refresh token still expires", async () => {
  const connection = await providers.createProviderConnection({
    provider: "antigravity", authType: "oauth", name: "Direct fixture",
    accessToken: "fixture-direct", refreshToken: null, isActive: true, testStatus: "active",
  });
  await health.checkConnection(connection);
  const updated = await providers.getProviderConnectionById(String(connection.id));
  assert.equal(updated?.testStatus, "expired");
  assert.equal(updated?.errorCode, "no_refresh_token");
});
