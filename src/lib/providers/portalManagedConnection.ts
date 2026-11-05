import { resetConnectionRefreshCircuit } from "@omniroute/open-sse/services/tokenRefresh/circuitBreaker.ts";

type ConnectionLike = {
  providerSpecificData?: Record<string, unknown> | null;
} | null | undefined;

export function isPortalManagedConnection(connection: ConnectionLike): boolean {
  const externalId = connection?.providerSpecificData?.portalExternalId;
  return typeof externalId === "string" && externalId.length > 0;
}

export function buildPortalRecoveryUpdate(psd: Record<string, unknown> = {}) {
  const providerSpecificData = { ...psd };
  delete providerSpecificData.expiredRetry;
  delete providerSpecificData.refreshCircuit;
  return {
    isActive: true,
    testStatus: "active",
    lastError: null,
    lastErrorAt: null,
    lastErrorType: null,
    lastErrorSource: null,
    errorCode: null,
    expiredRetryCount: null,
    expiredRetryAt: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
    providerSpecificData,
  };
}

export function resetPortalRefreshCircuit(provider: string, connectionId: string): void {
  resetConnectionRefreshCircuit(provider, connectionId);
}

export function clearPortalHealthState(
  providerSpecificData: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...providerSpecificData };
  delete next.refreshCircuit;
  delete next.expiredRetry;
  return next;
}

const FORBIDDEN_TOKEN_KEYS = new Set([
  "refreshtoken",
  "refreshtokenexpiresat",
  "refreshtokenexpiry",
  "refresh_token",
  "refresh_token_expires_at",
  "refresh_token_expiry",
]);

/**
 * Detect refresh-token material anywhere in a Portal push body — top-level or
 * nested inside `providerSpecificData`. Portal is the sole owner of the rotating
 * refresh token; persisting one here would let two routers race the same
 * single-use token. Returns the offending path for the error message, or null.
 */
export function findForbiddenTokenField(value: unknown, path = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenTokenField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_TOKEN_KEYS.has(key.toLowerCase())) return nextPath;
    const found = findForbiddenTokenField(nested, nextPath);
    if (found) return found;
  }
  return null;
}
