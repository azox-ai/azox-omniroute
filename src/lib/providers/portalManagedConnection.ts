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
