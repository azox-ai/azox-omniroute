import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-portal-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.PORTAL_SYNC_TOKEN = "portal-secret-token";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const route = await import("../../src/app/api/internal/portal/connections/[externalId]/route.ts");
const portalSync = await import("../../src/lib/auth/portalSync.ts");
const refreshBreaker = await import("../../open-sse/services/tokenRefresh/circuitBreaker.ts");

const AUTH = { authorization: "Bearer portal-secret-token" };

function putRequest(body: unknown, headers: Record<string, string> = AUTH) {
  return new Request("http://localhost/api/internal/portal/connections/ext-1", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function params(externalId: string) {
  return { params: Promise.resolve({ externalId }) };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    provider: "claude",
    accessToken: "access-1",
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("hasValidPortalSyncToken requires the exact Bearer prefix and a matching secret", () => {
  const make = (value?: string) =>
    new Request("http://localhost/x", value ? { headers: { authorization: value } } : undefined);

  assert.equal(portalSync.hasValidPortalSyncToken(make("Bearer portal-secret-token")), true);
  assert.equal(portalSync.hasValidPortalSyncToken(make("bearer portal-secret-token")), false);
  assert.equal(portalSync.hasValidPortalSyncToken(make("Bearer wrong")), false);
  assert.equal(portalSync.hasValidPortalSyncToken(make()), false);
  assert.equal(portalSync.hasValidPortalSyncToken(make("portal-secret-token")), false);
});

test("PUT rejects a missing or wrong Portal token before touching the database", async () => {
  await resetStorage();

  const noAuth = await route.PUT(putRequest(validBody(), {}), params("ext-1"));
  assert.equal(noAuth.status, 401);

  const badAuth = await route.PUT(
    putRequest(validBody(), { authorization: "Bearer nope" }),
    params("ext-1")
  );
  assert.equal(badAuth.status, 401);

  assert.equal((await providersDb.getProviderConnections()).length, 0);
});

test("PUT creates a Portal-managed row with no refresh token", async () => {
  await resetStorage();

  const response = await route.PUT(putRequest(validBody()), params("ext-1"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.provider, "claude");
  assert.equal(body.enabled, true);
  assert.equal(body.tokenVersion, 1);

  const rows = await providersDb.getProviderConnections();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerSpecificData?.portalExternalId, "ext-1");
  assert.equal(rows[0].providerSpecificData?.portalTokenVersion, 1);
  assert.ok(!rows[0].refreshToken, "Portal rows must never hold a refresh token");
});

test("PUT rejects a stale tokenVersion with 409", async () => {
  await resetStorage();

  await route.PUT(putRequest(validBody({ tokenVersion: 5 })), params("ext-1"));
  const stale = await route.PUT(putRequest(validBody({ tokenVersion: 2 })), params("ext-1"));

  assert.equal(stale.status, 409);
  const body = (await stale.json()) as Record<string, unknown>;
  assert.equal(body.error, "Stale tokenVersion");
  assert.equal(body.tokenVersion, 5);
});

test("PUT handles simultaneous versions atomically and refuses an older write", async () => {
  await resetStorage();
  const expiry = new Date(Date.now() + 3600_000).toISOString();
  const [first, second] = await Promise.all([
    route.PUT(
      putRequest(validBody({ tokenVersion: 3, accessToken: "old", expiresAt: expiry })),
      params("ext-1")
    ),
    route.PUT(
      putRequest(validBody({ tokenVersion: 4, accessToken: "new", expiresAt: expiry })),
      params("ext-1")
    ),
  ]);
  assert.ok([200, 409].includes(first.status));
  assert.equal(second.status, 200);
  const rows = await providersDb.getProviderConnections();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accessToken, "new");
  assert.equal(rows[0].providerSpecificData?.portalTokenVersion, 4);
});

test("PUT equal-version retries are idempotent but a changed payload conflicts", async () => {
  await resetStorage();
  const input = validBody({ providerSpecificData: { organizationUUID: "org-1" } });
  const initial = await route.PUT(putRequest(input), params("ext-1"));
  const id = ((await initial.json()) as { id: string }).id;
  const replay = await route.PUT(putRequest(input), params("ext-1"));
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { id: string }).id, id);
  for (const changed of [
    { ...input, accessToken: "different" },
    { ...input, enabled: false },
    { ...input, email: "new@example.test" },
    { ...input, providerSpecificData: { organizationUUID: "org-2" } },
  ]) {
    const conflict = await route.PUT(putRequest(changed), params("ext-1"));
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { tokenVersion: number }).tokenVersion, 1);
  }
  const stored = await providersDb.getProviderConnectionById(id);
  assert.equal(stored?.accessToken, "access-1");
  assert.equal(stored?.providerSpecificData?.organizationUUID, "org-1");
});

test("PUT never overwrites an OAuth connection that shares the same email", async () => {
  await resetStorage();
  const unrelated = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "shared@example.test",
    accessToken: "unrelated-token",
    providerSpecificData: { organizationUUID: "org-other" },
  });
  const portal = await route.PUT(
    putRequest(
      validBody({
        email: "shared@example.test",
        providerSpecificData: { organizationUUID: "org-portal" },
      })
    ),
    params("ext-1")
  );
  assert.equal(portal.status, 200);
  assert.notEqual(((await portal.json()) as { id: string }).id, unrelated.id);
  const rows = await providersDb.getProviderConnections();
  assert.equal(rows.length, 2);
  const original = await providersDb.getProviderConnectionById(String(unrelated.id));
  assert.equal(original?.accessToken, "unrelated-token");
  assert.equal(original?.providerSpecificData?.portalExternalId, undefined);
});

test("PUT keeps expiresAt and tokenExpiresAt aligned on create and rotation", async () => {
  await resetStorage();
  const firstExpiry = "2026-12-01T00:00:00.000Z";
  const secondExpiry = "2026-12-02T00:00:00.000Z";
  const first = await route.PUT(putRequest(validBody({ expiresAt: firstExpiry })), params("ext-1"));
  const id = ((await first.json()) as { id: string }).id;
  let row = await providersDb.getProviderConnectionById(id);
  assert.equal(row?.expiresAt, firstExpiry);
  assert.equal(row?.tokenExpiresAt, firstExpiry);
  const rotated = await route.PUT(
    putRequest(validBody({ tokenVersion: 2, expiresAt: secondExpiry })),
    params("ext-1")
  );
  assert.equal(rotated.status, 200);
  row = await providersDb.getProviderConnectionById(id);
  assert.equal(row?.expiresAt, secondExpiry);
  assert.equal(row?.tokenExpiresAt, secondExpiry);
});

test("PUT refuses to change the provider of an existing external id", async () => {
  await resetStorage();

  await route.PUT(putRequest(validBody()), params("ext-1"));
  const swap = await route.PUT(
    putRequest(validBody({ provider: "codex", tokenVersion: 2 })),
    params("ext-1")
  );

  assert.equal(swap.status, 409);
  assert.equal(
    ((await swap.json()) as Record<string, unknown>).error,
    "Provider cannot be changed"
  );
});

test("PUT rejects refresh-token material at top level and nested in providerSpecificData", async () => {
  await resetStorage();

  const topLevel = await route.PUT(
    putRequest(validBody({ refreshToken: "sneaky" })),
    params("ext-1")
  );
  assert.equal(topLevel.status, 400);

  const nested = await route.PUT(
    putRequest(validBody({ providerSpecificData: { nested: { refresh_token: "sneaky" } } })),
    params("ext-1")
  );
  assert.equal(nested.status, 400);

  assert.equal((await providersDb.getProviderConnections()).length, 0);
});

test("PUT heals a poisoned row: clears .53 expiredRetry/refreshCircuit, keeps Portal markers", async () => {
  await resetStorage();

  const existing = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Sponsored by: anhth2",
    accessToken: "old-access",
    refreshToken: "legacy-refresh",
    testStatus: "expired",
    isActive: false,
    errorCode: "no_refresh_token",
    providerSpecificData: {
      portalExternalId: "ext-1",
      portalTokenVersion: 1,
      expiredRetry: { count: 4, at: "2026-10-01T00:00:00.000Z" },
      refreshCircuit: { streak: 3, until: "2026-10-01T00:10:00.000Z", lastFailAt: "x" },
      keepMe: "yes",
    },
  });

  const breakerOptions = {
    scope: "connection" as const,
    connectionId: String(existing.id),
    failureThreshold: 1,
  };
  await refreshBreaker.refreshWithRetry(async () => null, 1, null, "claude", breakerOptions);
  assert.equal(refreshBreaker.isProviderBlocked("claude", breakerOptions), true);

  const response = await route.PUT(putRequest(validBody({ tokenVersion: 2 })), params("ext-1"));
  assert.equal(response.status, 200);
  assert.equal(refreshBreaker.isProviderBlocked("claude", breakerOptions), false);

  const updated = await providersDb.getProviderConnectionById(String(existing.id));
  assert.equal(updated?.testStatus, "active");
  assert.equal(updated?.isActive, true);
  assert.equal(updated?.errorCode ?? null, null);
  assert.ok(!updated?.refreshToken, "the legacy refresh token must be cleared");
  assert.equal(updated?.providerSpecificData?.portalExternalId, "ext-1");
  assert.equal(updated?.providerSpecificData?.portalTokenVersion, 2);
  assert.equal(updated?.providerSpecificData?.keepMe, "yes");
  assert.equal(updated?.providerSpecificData?.expiredRetry, undefined);
  assert.equal(updated?.providerSpecificData?.refreshCircuit, undefined);
});

test("GET reports the row without leaking any token", async () => {
  await resetStorage();

  await route.PUT(putRequest(validBody()), params("ext-1"));
  const response = await route.GET(putRequest(validBody()), params("ext-1"));
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.found, true);
  assert.equal(body.provider, "claude");
  assert.equal(body.tokenVersion, 1);
  assert.ok(!("accessToken" in body));
  assert.ok(!("refreshToken" in body));
  assert.ok(!("idToken" in body));
  assert.ok(!("providerSpecificData" in body));
});

test("GET and DELETE return 404 for an unknown external id", async () => {
  await resetStorage();

  assert.equal((await route.GET(putRequest(validBody()), params("missing"))).status, 404);
  assert.equal((await route.DELETE(putRequest(validBody()), params("missing"))).status, 404);
});

test("DELETE removes the managed row", async () => {
  await resetStorage();

  await route.PUT(putRequest(validBody()), params("ext-1"));
  const response = await route.DELETE(putRequest(validBody()), params("ext-1"));

  assert.equal(response.status, 204);
  assert.equal((await providersDb.getProviderConnections()).length, 0);
});
