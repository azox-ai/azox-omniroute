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
| Internal Portal route, DB upsert, management-auth carve-out, `PORTAL_SYNC_TOKEN` (D2) | Ported | `src/app/api/internal/portal/connections/[externalId]/route.ts`, `src/proxy.ts`, `src/lib/auth/portalSync.ts` |

`PUT` calls `buildPortalRecoveryUpdate()` to heal stale error and retry state.
The route rejects refresh tokens on the raw body, clears legacy stored refresh tokens,
and resets the connection-scoped runtime refresh breaker after a successful push.

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
  successful refresh. Run these fixtures and the route tests before rollout.
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

Also run `tests/unit/portal-sync-route.test.ts`, `tests/unit/portal-sync-metadata.test.ts`,
and the existing direct-login refresh tests before rollout.

### Upstream upgrade checklist

1. Confirm `portalExternalId` remains the marker through schema and
   serialization changes.
2. Confirm the sweep, reactive refresh and manual test paths still return before
   any refresh endpoint call for Portal rows.
3. Confirm nested `expiredRetry` and `refreshCircuit` are cleared on recovery.
4. Confirm direct-login OAuth refresh tests remain unchanged and passing.
5. Confirm a large terminal Responses event produces no extra `response.failed`.
6. Before rollout, smoke one Codex and one Claude request through the gateway.
