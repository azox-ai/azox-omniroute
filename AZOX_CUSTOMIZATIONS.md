# AZOX customizations

## Portal-managed OAuth credentials — upgrade critical

> **Do not drop or weaken this contract during an upstream upgrade.** Review the
> implementation and regression tests explicitly on every upstream merge,
> rebase, reset, authentication refactor or credential-health change.

LLM Portal is the sole owner of rotating Codex and Claude OAuth refresh tokens.
OmniRoute must receive only the current access token, expiry, monotonic token
version and safe identity metadata. Sharing the rotating refresh token with
multiple routers would let one process invalidate the others.

Portal-managed connections are identified by a nonempty string in
`providerSpecificData.portalExternalId`. The following behavior is mandatory:

- Never locally refresh a Portal-managed row.
- Never classify its intentionally absent refresh token as `no_refresh_token`,
  `expired` or a re-auth requirement.
- Never increment expired retries or deactivate it from the credential health
  sweep, a manual connection test or a reactive refresh. Recovery authority
  belongs to the next Portal push.
- Clear stale error, retry and terminal health fields on every Portal push, so
  rows poisoned by an older release heal automatically.
- Preserve normal local refresh behavior for direct-login OAuth rows that do
  not have `portalExternalId`.
- Never accept or persist the Portal refresh token.

### Status in this upgrade

| Area | Status | Files |
|---|---|---|
| Marker and recovery helper (D1) | Ported | `src/lib/providers/portalManagedConnection.ts` |
| Health sweep guard (D1) | Ported | `src/lib/tokenHealthCheck.ts` |
| Reactive refresh and manual test guards (D1) | Ported | `open-sse/services/tokenRefresh.ts`, `src/app/api/providers/[id]/test/route.ts` |
| Large terminal SSE event fix, F4 (D1) | Ported | `open-sse/utils/earlyStreamKeepalive.ts` |
| Internal Portal route, atomic DB upsert, narrow management-auth carve-out (D2; no migration) | Source ported; qualification pending | `src/lib/db/portalConnections.ts`, `src/app/api/internal/portal/connections/[externalId]/route.ts`, `src/lib/auth/portalSync.ts` |

The D2 source calls `buildPortalRecoveryUpdate()` inside the DB write transaction.
This describes source intent only: D1 and D2 tests remain **NOT RUN** and neither
change has runtime qualification clearance.

### Skip contract for Portal rows

- A Portal row's connection test returns `skipped: true` with diagnosis code
  `portal_managed` and writes nothing. `src/lib/credentialHealth/scheduler.ts`
  honors `skipped` by not caching an `error`, so these skips do not cause
  `checkCredentialGate` to block a Portal row. Pre-existing cached errors are
  not cleared by a skip. Returning plain `valid: false` would make the scheduler
  cache `error` and the combo gate skip the row.
- `getAccessToken` answers `NO_REFRESH_NEEDED` for Portal rows. `refreshWithRetry`
  treats that sentinel as nothing attempted, so repeated 401s on Portal rows do
  not trip the provider-scoped refresh breaker for direct-login rows.
- `CodexExecutor.refreshCredentials` returns that sentinel before checking for a
  missing refresh token, including the Portal contract's `refreshToken: null`.
  Fixtures exercise the real executor through `refreshWithRetry` seven times,
  check no fetch/persist or row mutation, and contrast direct-login failure and
  successful refresh. These fixtures are **NOT RUN** under the D1 execution gate.
- Known gap: `open-sse/executors/antigravity.ts` `refreshCredentials` calls the
  refresh endpoint without `getAccessToken` and has no Portal guard. The
  Portal contract provisions only `claude` and `codex` rows, and Portal rows
  carry no refresh token (that executor returns early), so D1 leaves it
  unchanged. Revisit if Portal ever manages Antigravity rows.

### Nested state checklist

`expiredRetry` and `refreshCircuit` live inside `providerSpecificData`, not in
top-level columns. Any recovery write must replace the whole
`providerSpecificData` with `buildPortalRecoveryUpdate(...).providerSpecificData`
(both keys removed) in addition to clearing top-level error fields. The
per-connection runtime refresh breaker is reset with `resetPortalRefreshCircuit`.
Re-check this list whenever upstream changes expired-retry, refresh-backoff or
circuit-breaker storage.

### SSE terminal events (F4)

`earlyStreamKeepalive` decides on the slow path whether a Responses stream sent
`response.completed`, `response.failed` or `response.incomplete`. An event over
65,536 characters before its blank-line terminator is classified from its
retained header (`event:` line or leading `data: {"type"`) before the buffer is
truncated, so a large terminal event no longer gets a false `response.failed`
with `stream_disconnected`. The buffer limit is unchanged.

### Required regression coverage

- `tests/unit/portal-managed-connection-health.test.ts`
- `tests/unit/earlyStreamKeepalive-terminal.test.ts`
- `tests/unit/token-health-no-refresh-token-expired-5326.test.ts`

Test status for D1: written, **NOT RUN** (no repo code was executed).

### Upstream upgrade checklist

1. Confirm `portalExternalId` remains the marker through schema and
   serialization changes.
2. Confirm the sweep, reactive refresh and manual test paths still return before
   any refresh endpoint call for Portal rows.
3. Confirm nested `expiredRetry` and `refreshCircuit` are cleared on recovery.
4. Confirm direct-login OAuth refresh tests remain unchanged and passing.
5. Confirm a large terminal Responses event produces no extra `response.failed`.
6. Before rollout, qualify D2 and smoke one Codex and one Claude request under separate clearance.

### Portal D2 source contract (AZO-1104)

- GET/PUT/DELETE use the same external ID validator: 1–128 ASCII letters,
  digits, `_`, `-`, or `.`, starting with a letter, digit, `_`, or `-`.
  Encoded separators, siblings, descendants and trailing slashes do not receive
  the Portal management-policy exception. Both policy and route verify the
  `PORTAL_SYNC_TOKEN` bearer with equal-length SHA-256 digests and timing-safe comparison.
  The policy checks original URL/nextUrl pathnames against the classified path;
  missing, malformed or disagreeing original paths cannot receive the Portal
  subject. Shared classifier normalization is unchanged.
  Missing/blank server configuration fails closed at the route.
- PUT uses a strict Zod allowlist. Provider is `claude` or `codex`; version is
  a safe integer >=1; expiry is an ISO datetime with timezone. Optional metadata
  is limited to `email`, `name`, `displayName`, `scope`, `tokenType`, `enabled`
  and scalar provider IDs/subscription metadata in `portalSyncInput.ts`.
  Unknown keys, refresh tokens, ID tokens, nested objects and caller-owned
  Portal markers are rejected, not persisted. Stored access tokens use existing
  encryption-at-rest handling, dependent on existing encryption configuration.
  D2 neither reads nor changes that configuration. Successful responses contain only
  `id`, `externalId`, `provider`, `enabled`, `expiresAt`, `tokenVersion`.
- `upsertPortalManagedConnection()` acquires the SQLite immediate write lock
  before marker lookup, version comparison and write. Inserts bypass direct-login
  email/identity deduplication. Lower versions or provider changes return 409.
  Equal versions are no-op 200 only when the canonical validated payload digest
  matches; different payloads or legacy rows without a digest return 409. Higher
  versions replace allowed metadata and recover state. Existing duplicate markers
  fail closed with 409 rather than adopting an arbitrary row. No schema/index change.
- Higher-version writes clear top-level errors/backoff, nested expiredRetry and
  refreshCircuit, persisted per-connection refresh/warmup circuit flags, the D1
  connection refresh breaker and the selected connection routing breaker.
  Operator-disable marker remains authoritative: pushes cannot reactivate that row.
  Shared provider breakers and direct-login state are not reset.
- Limits: in-memory resets affect only the handling process; other workers may
  retain cached state. A DB commit and process-local reset are not one atomic
  operation. Shared provider outages, old credential-health cache entries,
  quota exhaustion and in-flight requests are not proven recovered. Equal-version
  retries intentionally do not mutate/recover state. DELETE selects/removes the
  marked row and account proxy/quota/runtime rows under the immediate lock.
  After commit it awaits existing combo and LKGP cleanup using the exact removed
  internal ID, never a second lookup by external ID. Connection/reasoning/proxy
  caches, selected connection health/rotation/limits state and native Codex turn
  pins are invalidated or removed. Direct-login IDs and provider-level LKGP pins
  are preserved. Async cleanup attempts all settle before return; a rejected
  cleanup returns sanitized 500, not rollback, and a repeated delete returns 404.
  The reused combo helper still handles individual update failures best-effort.
  Post-commit cleanup is not atomic with row deletion, has no cross-process
  registry guarantee and does not cover every runtime registry. Runtime proof
  remains blocked; failed cleanup may require separately authorized repair.
- Rollout token creation/configuration, real DB changes, migration, deployment
  and qualification remain separate gates. This output configures no real token.

| Acceptance | Source | Fixtures (written, NOT RUN) |
| --- | --- | --- |
| A1/F1 | `portalSync.ts`, management policy, route auth | `portal-sync-d2.test.ts`: real classifier then policy, original trailing slash/sibling/descendant/encoded separator negatives, fail-closed path/bearer |
| A2 | `portalConnections.ts`: immediate transaction, digest/version checks | versions no-op/conflict/no-downgrade |
| A3 | `portalConnections.ts`: marker lookup and direct insert under lock | independent workers: two creates, v4/v5; `portal-sync-race-worker.mjs` |
| A4 | DB recovery + D1 helper + route connection reset | poisoned row recovery, nested secret rejection, no refresh persistence |
| A5 | D1 health/reactive/manual-test guards unchanged | existing `portal-managed-connection-health.test.ts` (NOT RUN) |
| A6 | direct insert; no direct-login mutation or provider reset | same-email no-adoption; direct-login fixture; existing `token-health-no-refresh-token-expired-5326.test.ts` unchanged |
| A7/F2 | shared ID validation, response projection, sanitized errors, targeted DELETE cleanup | GET/DELETE/invalid IDs, DB failures, Portal combo/LKGP refs with direct-login controls, post-commit cleanup failure |
| A8 | strict provider enum, conflict inside transaction | Claude/Codex positive, invalid/change-provider negative |

Verification: source review only. Test/lint/typecheck/build and RED/GREEN are
**NOT RUN** because Task3/V1–V9 clearance has not been granted. No runtime PASS.
