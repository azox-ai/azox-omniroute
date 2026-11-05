import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-portal-d2-"));
process.env.DATA_DIR = dataDir;
process.env.PORTAL_SYNC_TOKEN = "fixture-portal-bearer";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const portal = await import("../../src/lib/db/portalConnections.ts");
const auth = await import("../../src/lib/auth/portalSync.ts");
const route = await import("../../src/app/api/internal/portal/connections/[externalId]/route.ts");
const refreshCircuit = await import("../../open-sse/services/tokenRefresh/circuitBreaker.ts");
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
const { connectionCircuitBreakerName } = await import(
  "../../open-sse/services/connectionCircuitBreaker.ts"
);
const { managementPolicy } = await import("../../src/server/authz/policies/management.ts");
const { classifyRoute } = await import("../../src/server/authz/classify.ts");
const combos = await import("../../src/lib/db/combos.ts");
const lkgp = await import("../../src/lib/db/settings/lkgp.ts");

const payload = (tokenVersion = 1) => ({
  provider: "codex" as const,
  accessToken: `fixture-access-${tokenVersion}`,
  tokenVersion,
  expiresAt: "2030-01-01T00:00:00.000Z",
  email: "fixture@example.invalid",
  providerSpecificData: { chatgptAccountId: "fixture-account" },
});
const context = (externalId: string) => ({ params: Promise.resolve({ externalId }) });
const request = (body?: unknown, bearer = "fixture-portal-bearer") =>
  new Request("http://localhost/api/internal/portal/connections/fixture", {
    method: body === undefined ? "GET" : "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.PORTAL_SYNC_TOKEN;
});

test("A1 exact Portal path and fail-closed bearer", async () => {
  assert.equal(auth.isPortalSyncPath("/api/internal/portal/connections/fixture"), true);
  for (const pathname of [
    "/api/internal/portal/connections", "/api/internal/portal/connections/",
    "/api/internal/portal/connections/fixture/child", "/api/internal/portal/sibling",
    "/api/internal/portal/connections/%2f", "/api/internal/portal/connections/..",
    "/api/internal/portal/connections/fixture/", "/api/internal/sibling",
  ]) assert.equal(auth.isPortalSyncPath(pathname), false, pathname);
  for (const bearer of ["", "wrong", "fixture-portal-bearer-extra"]) {
    assert.equal((await route.GET(request(undefined, bearer), context("auth"))).status, 401);
  }
  assert.equal((await route.GET(new Request("http://localhost"), context("auth"))).status, 401);
  delete process.env.PORTAL_SYNC_TOKEN;
  assert.equal((await route.GET(request(), context("auth"))).status, 401);
  process.env.PORTAL_SYNC_TOKEN = "   ";
  assert.equal(auth.hasValidPortalSyncToken(request(undefined, "   ")), false);
  process.env.PORTAL_SYNC_TOKEN = "fixture-portal-bearer";
});

test("F1 classifier then policy grants Portal subject only to original exact pathname", async () => {
  for (const pathname of [
    "/api/internal/portal/connections/fixture",
    "/api/internal/portal/connections/fixture/",
    "/api/internal/portal/connections/fixture/child",
    "/api/internal/portal/connections/fixture%2Fchild",
    "/api/internal/portal/connections/fixture%5Cchild",
    "/api/internal/portal/connections/%66ixture",
    "/api/internal/portal/sibling",
    "/api/internal/sibling",
  ]) {
    const classification = classifyRoute(pathname, "PUT");
    for (const original of [
      { url: `https://example.invalid${pathname}` },
      { nextUrl: { pathname } },
      { url: `https://example.invalid${pathname}`, nextUrl: { pathname } },
    ]) {
      const outcome = await managementPolicy.evaluate({
        request: { method: "PUT", headers: request().headers, ...original },
        classification,
        requestId: "fixture-policy",
      });
      const portalAllowed = outcome.allow && outcome.subject.id === "portal-sync";
      assert.equal(portalAllowed, pathname === "/api/internal/portal/connections/fixture", pathname);
    }
  }
  const exactPath = "/api/internal/portal/connections/fixture";
  for (const original of [
    {}, { url: "invalid-url" },
    { url: `https://example.invalid${exactPath}/`, nextUrl: { pathname: exactPath } },
    { url: `https://example.invalid${exactPath}`, nextUrl: { pathname: `${exactPath}/` } },
  ]) {
    const outcome = await managementPolicy.evaluate({
      request: { method: "PUT", headers: request().headers, ...original },
      classification: classifyRoute(exactPath, "PUT"), requestId: "fixture-fail-closed",
    });
    assert.equal(outcome.allow && outcome.subject.id === "portal-sync", false);
  }
});

test("F2 DELETE cleans only removed Portal ID in combo refs and LKGP", async () => {
  const managed = portal.upsertPortalManagedConnection("delete-refs", payload());
  const direct = await providers.createProviderConnection({
    provider: "codex", authType: "oauth", email: "delete-control@example.invalid",
    accessToken: "fixture-direct-control", refreshToken: "fixture-direct-refresh-control",
    providerSpecificData: {},
  });
  const directBefore = await providers.getProviderConnectionById(direct.id);
  const combo = await combos.createCombo({
    name: "fixture-delete-refs",
    models: [
      { model: "codex/fixture", connectionId: managed.connection.id,
        allowedConnectionIds: [managed.connection.id, direct.id] },
      { model: "codex/control", connectionId: direct.id, allowedConnectionIds: [direct.id] },
    ],
  });
  const controlCombo = await combos.createCombo({
    name: "fixture-delete-untouched",
    models: [{ model: "codex/control", connectionId: direct.id }],
  });
  const controlBefore = await combos.getComboById(String(controlCombo.id));
  const comboBefore = await combos.getComboById(String(combo.id));
  const expectedModels = (comboBefore!.models as Record<string, unknown>[]).map((step) => {
    const result = { ...step };
    if (result.connectionId === managed.connection.id) delete result.connectionId;
    if (Array.isArray(result.allowedConnectionIds)) {
      result.allowedConnectionIds = result.allowedConnectionIds.filter(
        (connectionId) => connectionId !== managed.connection.id
      );
    }
    return result;
  });
  await lkgp.setLKGP("fixture-delete-refs", "fixture", "codex", managed.connection.id);
  await lkgp.setLKGP("fixture-delete-refs", "control", "codex", direct.id);
  await lkgp.setLKGP("fixture-provider-pin", "fixture", "codex");
  const response = await route.DELETE(request(), context("delete-refs"));
  assert.equal(response.status, 204);
  assert.equal(portal.getPortalManagedConnection("delete-refs"), null);
  const updated = await combos.getComboById(String(combo.id));
  assert.deepEqual(updated!.models, expectedModels);
  const updatedModels = updated!.models as Record<string, unknown>[];
  assert.equal(updatedModels[0].connectionId, undefined);
  assert.deepEqual(updatedModels[0].allowedConnectionIds, [direct.id]);
  assert.equal(updatedModels[1].connectionId, direct.id);
  assert.deepEqual(updatedModels[1].allowedConnectionIds, [direct.id]);
  assert.equal(await lkgp.getLKGP("fixture-delete-refs", "fixture"), null);
  assert.deepEqual(await lkgp.getLKGP("fixture-delete-refs", "control"),
    { provider: "codex", connectionId: direct.id });
  assert.deepEqual(await lkgp.getLKGP("fixture-provider-pin", "fixture"), { provider: "codex" });
  assert.deepEqual(await providers.getProviderConnectionById(direct.id), directBefore);
  assert.deepEqual(await combos.getComboById(String(controlCombo.id)), controlBefore);
  const replacement = portal.upsertPortalManagedConnection("delete-refs", payload(2));
  assert.notEqual(replacement.connection.id, managed.connection.id);
  assert.equal(portal.getPortalManagedConnection("delete-refs")!.id, replacement.connection.id);
});

test("F2 cleanup failure returns sanitized 500 after committed delete, not rollback", async () => {
  const managed = portal.upsertPortalManagedConnection("delete-cleanup-failure", payload());
  await lkgp.setLKGP("fixture-cleanup-failure", "fixture", "codex", managed.connection.id);
  const db = core.getDbInstance();
  const original = db.prepare;
  db.prepare = (sql: string) => {
    if (sql === "SELECT key, value FROM key_value WHERE namespace = 'lkgp'") {
      throw new Error("fixture-private-cleanup-secret");
    }
    return original.call(db, sql);
  };
  try {
    const response = await route.DELETE(request(), context("delete-cleanup-failure"));
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes("fixture-private-cleanup-secret"), false);
    assert.equal(portal.getPortalManagedConnection("delete-cleanup-failure"), null);
    assert.equal((await route.DELETE(request(), context("delete-cleanup-failure"))).status, 404);
  } finally {
    db.prepare = original;
    await lkgp.clearLKGP("fixture-cleanup-failure", "fixture");
  }
});

test("A2 versions never downgrade; equal payload is no-op, equal version conflict is explicit", async () => {
  assert.equal((await route.PUT(request(payload(5)), context("versions"))).status, 201);
  const before = core.getDbInstance().prepare("SELECT * FROM provider_connections WHERE id = ?")
    .get(portal.getPortalManagedConnection("versions")!.id);
  assert.equal((await route.PUT(request(payload(4)), context("versions"))).status, 409);
  assert.equal((await route.PUT(request(payload(5)), context("versions"))).status, 200);
  assert.equal((await route.PUT(request({ ...payload(5), accessToken: "fixture-other" }),
    context("versions"))).status, 409);
  assert.deepEqual(core.getDbInstance().prepare("SELECT * FROM provider_connections WHERE id = ?")
    .get(portal.getPortalManagedConnection("versions")!.id), before);
});

test("A3 independent workers contend on two creates and versions 4/5", async () => {
  core.getDbInstance();
  async function race(externalId: string, versions: number[]) {
    const workers = versions.map((tokenVersion) => new Worker(
      new URL("../fixtures/portal-sync-race-worker.mjs", import.meta.url), {
        workerData: { dataDir, externalId, input: payload(tokenVersion) },
      }
    ));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", () => resolve());
    })));
    const finished = Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker ${code}`)));
    })));
    for (const worker of workers) worker.postMessage("go");
    await finished;
    const rows = core.getDbInstance().prepare(
      "SELECT provider_specific_data FROM provider_connections WHERE json_extract(provider_specific_data, '$.portalExternalId') = ?"
    ).all(externalId) as { provider_specific_data: string }[];
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].provider_specific_data).portalTokenVersion, Math.max(...versions));
  }
  await race("two-create", [1, 1]);
  await race("version-race", [4, 5]);
});

test("A4/A6 recovery, no adoption, no refresh persistence, operator intent", async () => {
  const direct = await providers.createProviderConnection({
    ...payload(), authType: "oauth", refreshToken: "fixture-direct-refresh",
    providerSpecificData: {},
  });
  const created = portal.upsertPortalManagedConnection("recovery", payload());
  assert.notEqual(created.connection.id, direct.id);
  await providers.updateProviderConnection(created.connection.id, {
    isActive: false, testStatus: "expired", lastError: "fixture expired",
    errorCode: "expired", lastErrorType: "auth", rateLimitedUntil: "2099-01-01",
    refreshToken: "fixture-poison", backoffLevel: 5,
    providerSpecificData: {
      portalExternalId: "recovery", portalTokenVersion: 1,
      expiredRetry: { count: 3 }, refreshCircuit: { until: "2099-01-01" },
      refresh_token: "fixture-poison", operatorDisabledAt: "2026-01-01",
    },
  });
  await refreshCircuit.refreshWithRetry(async () => null, 1, null, "codex", {
    scope: "connection", connectionId: created.connection.id, failureThreshold: 1,
  });
  const connectionBreaker = getCircuitBreaker(connectionCircuitBreakerName("codex", created.connection.id));
  for (let attempt = 0; attempt < 30; attempt++) connectionBreaker._onFailure();
  const directBreaker = getCircuitBreaker(connectionCircuitBreakerName("codex", direct.id));
  for (let attempt = 0; attempt < 30; attempt++) directBreaker._onFailure();
  const directState = directBreaker.getStatus().state;
  core.getDbInstance().prepare(
    `INSERT INTO connection_runtime_state
     (connection_id, refresh_circuit_streak, refresh_circuit_until,
      warmup_circuit_streak, warmup_circuit_until)
     VALUES (?, 3, '2099-01-01', 3, '2099-01-01')`
  ).run(created.connection.id);
  const updated = await route.PUT(request(payload(2)), context("recovery"));
  assert.equal(updated.status, 200);
  const row = await providers.getProviderConnectionById(created.connection.id);
  assert.equal(row!.isActive, false);
  assert.equal(row!.testStatus, "active");
  const raw = core.getDbInstance().prepare("SELECT * FROM provider_connections WHERE id = ?")
    .get(created.connection.id) as Record<string, unknown>;
  assert.equal(raw.refresh_token, null);
  assert.equal(raw.last_error, null);
  assert.equal(row!.backoffLevel, 0);
  assert.equal(row!.providerSpecificData.expiredRetry, undefined);
  assert.equal(row!.providerSpecificData.refreshCircuit, undefined);
  assert.equal(row!.providerSpecificData.refresh_token, undefined);
  assert.equal(row!.providerSpecificData.operatorDisabledAt, "2026-01-01");
  assert.equal(connectionBreaker.getStatus().state, "CLOSED");
  assert.equal(directBreaker.getStatus().state, directState);
  const runtimeState = core.getDbInstance().prepare(
    "SELECT * FROM connection_runtime_state WHERE connection_id = ?"
  ).get(created.connection.id) as Record<string, unknown>;
  assert.equal(runtimeState.refresh_circuit_streak, 0);
  assert.equal(runtimeState.refresh_circuit_until, null);
  assert.equal(runtimeState.warmup_circuit_streak, 0);
  assert.equal(runtimeState.warmup_circuit_until, null);
  assert.equal(Object.keys(refreshCircuit.getCircuitBreakerStatus())
    .some((key) => key.includes(created.connection.id)), false);
  assert.equal((await providers.getProviderConnectionById(direct.id))!.refreshToken,
    "fixture-direct-refresh");
  assert.equal((await providers.getProviderConnectionById(direct.id))!.isActive, true);
  directBreaker.reset();
});

test("A4 non-operator expired row reactivates on higher version", async () => {
  const created = portal.upsertPortalManagedConnection("auto-recovery", payload());
  await providers.updateProviderConnection(created.connection.id, {
    isActive: false, testStatus: "expired", lastError: "fixture-expired",
    providerSpecificData: { portalExternalId: "auto-recovery", portalTokenVersion: 1,
      expiredRetry: { count: 4 }, refreshCircuit: { until: "2099-01-01" } },
  });
  assert.equal((await route.PUT(request(payload(2)), context("auto-recovery"))).status, 200);
  const row = await providers.getProviderConnectionById(created.connection.id);
  assert.equal(row!.isActive, true);
  assert.equal(row!.testStatus, "active");
});

test("A4 reject unknown/nested credential fields before persistence", async () => {
  for (const input of [
    { ...payload(), refreshToken: "fixture-forbidden" },
    { ...payload(), refresh_token: "fixture-forbidden" },
    { ...payload(), idToken: "fixture-forbidden" },
    { ...payload(), providerSpecificData: { refreshToken: "fixture-forbidden" } },
    { ...payload(), providerSpecificData: { nested: { refresh_token: "fixture-forbidden" } } },
    { ...payload(), providerSpecificData: { portalExternalId: "other" } },
  ]) {
    assert.equal((await route.PUT(request(input), context("secrets"))).status, 400);
    assert.equal(portal.getPortalManagedConnection("secrets"), null);
  }
});

test("A7 GET/DELETE allowlist, repeated delete, invalid externalId on every method", async () => {
  await route.PUT(request(payload()), context("metadata"));
  const response = await route.GET(request(), context("metadata"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(),
    ["enabled", "expiresAt", "externalId", "id", "provider", "tokenVersion"].sort());
  assert.equal(JSON.stringify(body).includes("fixture-access"), false);
  assert.equal((await route.DELETE(request(), context("metadata"))).status, 204);
  assert.equal((await route.DELETE(request(), context("metadata"))).status, 404);
  for (const externalId of ["", "x".repeat(129), "a/b", ".", "..", "%2f"]) {
    for (const method of [route.GET, route.PUT, route.DELETE]) {
      assert.equal((await method(request(payload()), context(externalId))).status, 400);
    }
  }
});

test("A8 provider validation/conflict and malformed payload", async () => {
  await route.PUT(request(payload()), context("provider"));
  assert.equal((await route.PUT(request({ ...payload(2), provider: "claude" }),
    context("provider"))).status, 409);
  for (const input of [
    { ...payload(), provider: "other" }, { ...payload(), tokenVersion: 0 },
    { ...payload(), tokenVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...payload(), tokenVersion: "1" }, { ...payload(), expiresAt: "not-a-date" },
    { ...payload(), accessToken: " " }, { ...payload(), enabled: "true" },
  ]) assert.equal((await route.PUT(request(input), context("invalid"))).status, 400);
  assert.equal((await route.PUT(request({ ...payload(), provider: "claude" }),
    context("claude"))).status, 201);
});

test("A7 malformed JSON and DB failure return sanitized errors without token/stack", async () => {
  const malformed = new Request("http://localhost", {
    method: "PUT", headers: { authorization: "Bearer fixture-portal-bearer" }, body: "{",
  });
  assert.equal((await route.PUT(malformed, context("errors"))).status, 400);
  const db = core.getDbInstance();
  const original = db.prepare;
  db.prepare = () => { throw new Error("fixture-access-secret /private/path stack"); };
  try {
    for (const method of [route.GET, route.PUT, route.DELETE]) {
      const response = await method(request(payload()), context("errors"));
      assert.equal(response.status, 500);
      const text = await response.text();
      assert.equal(/fixture-access|private|stack/.test(text), false);
    }
  } finally {
    db.prepare = original;
  }
});
