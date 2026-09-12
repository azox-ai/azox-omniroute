# AZOX customizations

## Portal-managed OAuth credentials — upgrade critical

> **Do not drop or weaken this contract during an upstream upgrade.** Review the
> implementation and regression tests explicitly on every upstream merge,
> rebase, reset, authentication refactor or credential-health change.

LLM Portal is the sole owner of rotating Codex and Claude OAuth refresh tokens.
OmniRoute receives only the current access token, expiry, monotonic token version
and safe identity metadata through
`/api/internal/portal/connections/{externalId}`. Sharing the rotating refresh
token with multiple routers would let one process invalidate the others.

Portal-managed connections are identified by
`providerSpecificData.portalExternalId`. The following behavior is mandatory:

- Never locally refresh a Portal-managed row.
- Never classify its intentionally absent refresh token as
  `no_refresh_token`, `expired` or a re-auth requirement.
- Never increment expired retries or deactivate it from the credential health
  sweep. Recovery authority belongs to the next Portal push.
- Clear stale error, retry and terminal health fields on every Portal `PUT`, so
  rows poisoned by an older release heal automatically.
- Preserve normal local refresh behavior for direct-login OAuth rows that do not
  have `portalExternalId`.
- Never accept or persist the Portal refresh token.

Primary implementation:

- `src/lib/providers/portalManagedConnection.ts`
- `src/lib/tokenHealthCheck.ts`
- `src/app/api/internal/portal/connections/[externalId]/route.ts`

Required regression coverage:

- `tests/unit/portal-managed-connection-health.test.ts`
- `tests/unit/token-health-no-refresh-token-expired-5326.test.ts`

### Incident reference

On 2026-09-11/12, the health sweep saw a Portal-managed Codex row with
`authType="oauth"` and no refresh token, marked it expired, and eventually set
`isActive=false`. Requests then exhausted fallback retries and surfaced HTTP
429. Temporarily disabling the bad Codex candidate made routing work again; the
durable fix is the lifecycle separation above.

### Upstream upgrade checklist

1. Confirm `portalExternalId` remains the management marker through schema and
   serialization changes.
2. Run both regression test files above.
3. Confirm a Portal push clears stale terminal state and reactivates routing.
4. Confirm direct-login OAuth refresh tests remain unchanged and passing.
5. Smoke one Codex and one Claude request through the production-style gateway
   before rollout.

The cross-repository authority and scheduler contract is documented in
`azox-llm-portal/docs/router-contracts.md`.
