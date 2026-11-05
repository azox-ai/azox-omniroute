import { createHash, randomUUID } from "node:crypto";

import {
  removeConnectionHealth,
  removeConnectionIndex,
} from "@omniroute/open-sse/services/apiKeyRotator.ts";
import { isValidPortalExternalId } from "@/lib/auth/portalSync";
import { buildPortalRecoveryUpdate } from "@/lib/providers/portalManagedConnection";
import { isOperatorDisabled } from "@/lib/providers/operatorDisable";
import { portalSyncInputSchema, type PortalSyncInput } from "@/lib/providers/portalSyncInput";
import { getDbInstance } from "./core";
import { encryptConnectionFields } from "./encryption";
import { invalidateDbCache } from "./readCache";
import { cleanupComboConnectionRefs } from "./combos";
import { deleteLKGPByConnectionIds } from "./settings/lkgp";
import { deleteProviderLimitsCache } from "./providerLimits";
import { bumpProxyConfigGeneration } from "./settings";
import { invalidateReasoningRoutingRuleCache } from "./reasoningRoutingRules";

type RawConnection = Record<string, unknown>;
export type PortalConnectionMetadata = {
  id: string;
  externalId: string;
  provider: string;
  enabled: boolean;
  expiresAt: string;
  tokenVersion: number;
};
export type PortalUpsertResult = {
  created: boolean;
  changed: boolean;
  connection: PortalConnectionMetadata;
};

export class PortalConnectionConflict extends Error {
  constructor() {
    super("Portal connection conflict");
  }
}

function findRows(externalId: string): RawConnection[] {
  return getDbInstance().prepare(
    `SELECT * FROM provider_connections
     WHERE json_extract(CASE WHEN json_valid(provider_specific_data)
       THEN provider_specific_data ELSE '{}' END, '$.portalExternalId') = ?`
  ).all(externalId) as RawConnection[];
}

function metadata(row: RawConnection): PortalConnectionMetadata {
  const psd = JSON.parse(String(row.provider_specific_data));
  return {
    id: String(row.id),
    externalId: psd.portalExternalId,
    provider: String(row.provider),
    enabled: row.is_active === 1 || row.is_active === true,
    expiresAt: String(row.expires_at),
    tokenVersion: psd.portalTokenVersion,
  };
}

export function getPortalManagedConnection(externalId: string): PortalConnectionMetadata | null {
  if (!isValidPortalExternalId(externalId)) throw new TypeError("Invalid externalId");
  const rows = findRows(externalId);
  if (rows.length > 1) throw new PortalConnectionConflict();
  return rows.length ? metadata(rows[0]) : null;
}

export function upsertPortalManagedConnection(
  externalId: string,
  input: PortalSyncInput
): PortalUpsertResult {
  if (!isValidPortalExternalId(externalId)) throw new TypeError("Invalid externalId");
  const parsed = portalSyncInputSchema.parse(input);
  const canonical = {
    provider: parsed.provider,
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
    enabled: parsed.enabled,
    email: parsed.email ?? null,
    name: parsed.name ?? null,
    displayName: parsed.displayName ?? null,
    scope: parsed.scope ?? null,
    tokenType: parsed.tokenType ?? null,
    providerSpecificData: parsed.providerSpecificData,
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  const db = getDbInstance();
  let result: PortalUpsertResult;
  db.immediate(() => {
    const rows = findRows(externalId);
    if (rows.length > 1) throw new PortalConnectionConflict();
    const existing = rows[0];
    const previous = existing ? JSON.parse(String(existing.provider_specific_data)) : {};
    if (existing) {
      const version = previous.portalTokenVersion;
      if (existing.provider !== parsed.provider || !Number.isSafeInteger(version) || version < 1 ||
        parsed.tokenVersion < version) throw new PortalConnectionConflict();
      if (parsed.tokenVersion === version) {
        if (previous.portalPayloadDigest !== digest) throw new PortalConnectionConflict();
        result = { created: false, changed: false, connection: metadata(existing) };
        return;
      }
    }
    const disabled = existing && isOperatorDisabled({ providerSpecificData: previous });
    const recovery = buildPortalRecoveryUpdate({
      ...parsed.providerSpecificData,
      ...(disabled ? { operatorDisabledAt: previous.operatorDisabledAt } : {}),
      portalExternalId: externalId,
      portalTokenVersion: parsed.tokenVersion,
      portalPayloadDigest: digest,
    });
    const encrypted = encryptConnectionFields({ accessToken: parsed.accessToken });
    const now = new Date().toISOString();
    const connectionId = existing ? String(existing.id) : randomUUID();
    const active = !disabled && parsed.enabled;
    const values = {
      id: connectionId,
      provider: parsed.provider,
      name: parsed.displayName ?? parsed.name ?? `Portal ${externalId}`,
      email: parsed.email ?? null,
      displayName: parsed.displayName ?? null,
      scope: parsed.scope ?? null,
      tokenType: parsed.tokenType ?? "Bearer",
      accessToken: encrypted.accessToken,
      expiresAt: parsed.expiresAt,
      isActive: active ? 1 : 0,
      testStatus: recovery.testStatus,
      providerSpecificData: JSON.stringify(recovery.providerSpecificData),
      now,
    };
    if (existing) {
      db.prepare(
        `UPDATE provider_connections SET
         auth_type = 'oauth', access_token = @accessToken, refresh_token = NULL,
         id_token = NULL, api_key = NULL, expires_at = @expiresAt, token_expires_at = @expiresAt,
         name = @name, email = @email, display_name = @displayName, scope = @scope,
         token_type = @tokenType, is_active = @isActive, test_status = @testStatus,
         last_error = NULL, last_error_at = NULL, last_error_type = NULL,
         last_error_source = NULL, error_code = NULL, rate_limited_until = NULL,
         backoff_level = 0, provider_specific_data = @providerSpecificData, updated_at = @now
         WHERE id = @id`
      ).run(values);
    } else {
      db.prepare(
        `INSERT INTO provider_connections
         (id, provider, auth_type, name, email, display_name, scope, token_type,
          access_token, expires_at, token_expires_at, is_active, test_status,
          provider_specific_data, priority, created_at, updated_at)
         VALUES (@id, @provider, 'oauth', @name, @email, @displayName, @scope, @tokenType,
          @accessToken, @expiresAt, @expiresAt, @isActive, @testStatus,
          @providerSpecificData,
          (SELECT COALESCE(MAX(priority), 0) + 1 FROM provider_connections WHERE provider = @provider),
          @now, @now)`
      ).run(values);
    }
    db.prepare(
      `UPDATE connection_runtime_state SET refresh_circuit_streak = 0,
       refresh_circuit_until = NULL, refresh_last_fail_at = NULL,
       warmup_circuit_streak = 0, warmup_circuit_until = NULL, warmup_last_fail_at = NULL,
       updated_at = ? WHERE connection_id = ?`
    ).run(now, connectionId);
    result = {
      created: !existing,
      changed: true,
      connection: {
        id: connectionId, externalId, provider: parsed.provider,
        enabled: active, expiresAt: parsed.expiresAt, tokenVersion: parsed.tokenVersion,
      },
    };
  });
  if (result!.changed) invalidateDbCache("connections", result!.connection.id);
  return result!;
}

export async function deletePortalManagedConnection(
  externalId: string
): Promise<PortalConnectionMetadata | null> {
  if (!isValidPortalExternalId(externalId)) throw new TypeError("Invalid externalId");
  const db = getDbInstance();
  let removed: PortalConnectionMetadata | null = null;
  db.immediate(() => {
    const rows = findRows(externalId);
    if (rows.length > 1) throw new PortalConnectionConflict();
    if (!rows.length) return;
    removed = metadata(rows[0]);
    db.prepare("DELETE FROM quota_snapshots WHERE connection_id = ?").run(removed.id);
    db.prepare("DELETE FROM connection_runtime_state WHERE connection_id = ?").run(removed.id);
    db.prepare("DELETE FROM proxy_assignments WHERE scope = 'account' AND scope_id = ?")
      .run(removed.id);
    db.prepare("DELETE FROM provider_connections WHERE id = ?").run(removed.id);
  });
  if (removed) {
    invalidateDbCache("connections", removed.id);
    invalidateReasoningRoutingRuleCache();
    bumpProxyConfigGeneration();
    removeConnectionHealth(removed.id);
    removeConnectionIndex(removed.id);
    const connectionId = removed.id;
    const cleanup = await Promise.allSettled([
      cleanupComboConnectionRefs(removed.id),
      deleteLKGPByConnectionIds([removed.id]),
      (async () => {
        deleteProviderLimitsCache(connectionId);
      })(),
      (async () => {
        const { revokeNativeCodexTurnPinsForConnection } = await import(
          "@omniroute/open-sse/services/combo/nativeCodexTurnPin.ts"
        );
        revokeNativeCodexTurnPinsForConnection(connectionId);
      })(),
    ]);
    if (cleanup.some((outcome) => outcome.status === "rejected")) {
      throw new Error("Portal connection cleanup failed");
    }
  }
  return removed;
}
