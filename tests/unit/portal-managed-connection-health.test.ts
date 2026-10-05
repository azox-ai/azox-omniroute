import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-portal-managed-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const tokenHealthCheck = await import("../../src/lib/tokenHealthCheck.ts");
const portalManaged = await import("../../src/lib/providers/portalManagedConnection.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("isPortalManagedConnection keys off the Portal external id", () => {
  assert.equal(
    portalManaged.isPortalManagedConnection({
      providerSpecificData: { portalExternalId: "portal-1" },
    }),
    true
  );
  assert.equal(portalManaged.isPortalManagedConnection({ providerSpecificData: {} }), false);
  assert.equal(portalManaged.isPortalManagedConnection(null), false);
});

// The Portal owns the single-use refresh token for sponsored Codex/Claude accounts and
// pushes only an access token. The sweep must never treat that as a dead credential.
test("a repeated sweep never disables a Portal-managed connection", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Sponsored by: anhth2",
    accessToken: "portal-access-token",
    refreshToken: null,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    testStatus: "active",
    isActive: true,
    providerSpecificData: { portalExternalId: "portal-4", portalTokenVersion: 300 },
  });

  for (let sweep = 0; sweep < 5; sweep++) {
    const fresh = await providersDb.getProviderConnectionById(String(connection.id));
    await tokenHealthCheck.checkConnection(fresh);
  }

  const updated = await providersDb.getProviderConnectionById(String(connection.id));
  assert.equal(updated?.isActive, true);
  assert.equal(updated?.testStatus, "active");
  assert.ok(!updated?.errorCode);
});

// An access token that lapsed before the Portal pushed a new one is a transient gap,
// not a re-auth condition: the row must stay active so the next push heals it.
test("an elapsed Portal access token does not become a terminal expired row", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Sponsored by: anhth2",
    accessToken: "portal-access-token",
    refreshToken: null,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    testStatus: "active",
    isActive: true,
    providerSpecificData: { portalExternalId: "portal-1", portalTokenVersion: 7 },
  });

  for (let sweep = 0; sweep < 5; sweep++) {
    const fresh = await providersDb.getProviderConnectionById(String(connection.id));
    await tokenHealthCheck.checkConnection(fresh);
  }

  const updated = await providersDb.getProviderConnectionById(String(connection.id));
  assert.equal(updated?.isActive, true);
  assert.notEqual(updated?.testStatus, "expired");
});

// Rows already poisoned by the old behaviour must recover on the next Portal push
// instead of waiting for a manual dashboard re-auth.
test("buildPortalRecoveryUpdate clears stale expired state from the old sweep", () => {
  const update = portalManaged.buildPortalRecoveryUpdate();

  assert.equal(update.testStatus, "active");
  assert.equal(update.lastError, null);
  assert.equal(update.errorCode, null);
  assert.equal(update.lastErrorType, null);
  assert.equal(update.expiredRetryCount, null);
});
