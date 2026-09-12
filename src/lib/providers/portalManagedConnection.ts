/**
 * LLM Portal owns the single-use OAuth refresh token for sponsored Codex/Claude
 * accounts and pushes only an access token to each router (see
 * `src/app/api/internal/portal/connections/[externalId]/route.ts`). Two routers
 * holding the same rotating refresh token would invalidate each other, so the
 * absence of a refresh token on these rows is by design — not a dead credential.
 *
 * The credential health sweep must therefore leave them alone: no local refresh,
 * no "needs re-auth" marking, and no deactivation. Recovery is a Portal push.
 */

type ConnectionLike = {
  providerSpecificData?: Record<string, unknown> | null;
} | null | undefined;

export function isPortalManagedConnection(connection: ConnectionLike): boolean {
  const externalId = connection?.providerSpecificData?.portalExternalId;
  return typeof externalId === "string" && externalId.length > 0;
}

/**
 * Fields that clear the terminal state a previous sweep could have written to a
 * Portal-managed row before it was recognised as such. Applied on every Portal
 * push so an already-poisoned connection heals without a dashboard re-auth.
 */
export function buildPortalRecoveryUpdate() {
  return {
    testStatus: "active",
    lastError: null,
    lastErrorAt: null,
    lastErrorType: null,
    lastErrorSource: null,
    errorCode: null,
    expiredRetryCount: null,
    expiredRetryAt: null,
  };
}
