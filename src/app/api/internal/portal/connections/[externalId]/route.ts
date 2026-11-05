import { NextResponse } from "next/server";
import { z } from "zod";
import { hasValidPortalSyncToken } from "@/lib/auth/portalSync";
import { deleteProviderConnection, getProviderConnections } from "@/models";
import { resolvePortalConnectionName } from "@/lib/providers/portalSyncMetadata";
import { upsertPortalProviderConnection } from "@/lib/db/providers";
import {
  findForbiddenTokenField,
  resetPortalRefreshCircuit,
} from "@/lib/providers/portalManagedConnection";

const ALLOWED_PROVIDERS = new Set(["claude", "codex"]);
const portalConnectionSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  accessToken: z.string().min(1),
  tokenVersion: z.number().int().min(1),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  enabled: z.boolean().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  displayName: z.string().optional(),
  idToken: z.string().optional(),
  scope: z.string().optional(),
  tokenType: z.string().optional(),
  providerSpecificData: z.record(z.string(), z.unknown()).optional(),
});

type Connection = Awaited<ReturnType<typeof getProviderConnections>>[number];
type ManagedConnection = Connection & { id: string; providerSpecificData: Record<string, unknown> };

function portalData(connection: Connection): Record<string, unknown> {
  const data = connection.providerSpecificData;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

async function findManagedConnection(externalId: string): Promise<ManagedConnection | null> {
  const connections = await getProviderConnections();
  const match = connections.find(
    (connection) =>
      typeof connection.id === "string" && portalData(connection).portalExternalId === externalId
  );
  return match ? (match as ManagedConnection) : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function normalizeBody(body: Record<string, unknown>) {
  const provider = body.provider;
  const accessToken = body.accessToken;
  const tokenVersion = body.tokenVersion;
  const expiresAt = new Date(String(body.expiresAt || ""));
  if (!ALLOWED_PROVIDERS.has(String(provider))) throw new Error("Unsupported provider");
  if (typeof accessToken !== "string" || !accessToken) throw new Error("accessToken is required");
  if (!Number.isSafeInteger(tokenVersion) || Number(tokenVersion) < 1)
    throw new Error("tokenVersion is invalid");
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("expiresAt is invalid");
  const providerSpecificData =
    body.providerSpecificData && typeof body.providerSpecificData === "object"
      ? { ...(body.providerSpecificData as Record<string, unknown>) }
      : {};
  delete providerSpecificData.portalExternalId;
  delete providerSpecificData.portalTokenVersion;
  delete providerSpecificData.portalPayloadHash;
  return {
    provider: String(provider),
    accessToken,
    tokenVersion: Number(tokenVersion),
    expiresAt: expiresAt.toISOString(),
    enabled: body.enabled !== false,
    email: typeof body.email === "string" ? body.email : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
    idToken: typeof body.idToken === "string" ? body.idToken : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    tokenType: typeof body.tokenType === "string" ? body.tokenType : undefined,
    providerSpecificData,
  };
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> }
) {
  if (!hasValidPortalSyncToken(request)) return unauthorized();
  const { externalId } = await params;
  if (!externalId || externalId.length > 128)
    return NextResponse.json({ error: "externalId is invalid" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  // Portal owns the rotating refresh token; a refresh token in the push body —
  // top-level or nested inside providerSpecificData — must never be persisted.
  // Checked on the RAW body: the schema strips unknown top-level keys, so a
  // refresh token would already be gone by the time `parsed.data` exists.
  const forbiddenField = findForbiddenTokenField(body);
  if (forbiddenField)
    return NextResponse.json(
      { error: `refresh token field is not accepted: ${forbiddenField}` },
      { status: 400 }
    );
  const parsed = portalConnectionSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const error =
      field === "provider"
        ? "Unsupported provider"
        : field === "accessToken"
          ? "accessToken is required"
          : field === "tokenVersion"
            ? "tokenVersion is invalid"
            : field === "expiresAt"
              ? "expiresAt is invalid"
              : "Invalid request";
    return NextResponse.json({ error }, { status: 400 });
  }
  const input = normalizeBody(parsed.data);
  const connectionName = resolvePortalConnectionName(input.displayName, input.name);
  const result = upsertPortalProviderConnection(externalId, {
    ...input,
    provider: input.provider as "claude" | "codex",
    ...(connectionName ? { name: connectionName } : {}),
  });
  if (result.status !== "ok") {
    const error =
      result.status === "stale"
        ? "Stale tokenVersion"
        : result.status === "provider_changed"
          ? "Provider cannot be changed"
          : "Conflicting tokenVersion payload";
    return NextResponse.json({ error, tokenVersion: result.tokenVersion }, { status: 409 });
  }
  resetPortalRefreshCircuit(input.provider, result.id);
  return NextResponse.json({
    id: result.id,
    provider: input.provider,
    enabled: input.enabled,
    expiresAt: input.expiresAt,
    tokenVersion: input.tokenVersion,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> }
) {
  if (!hasValidPortalSyncToken(request)) return unauthorized();
  const { externalId } = await params;
  const connection = await findManagedConnection(externalId);
  if (!connection) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({
    found: true,
    id: connection.id,
    provider: connection.provider,
    enabled: connection.isActive !== false,
    expiresAt: connection.expiresAt || null,
    tokenVersion: Number(connection.providerSpecificData?.portalTokenVersion || 0),
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> }
) {
  if (!hasValidPortalSyncToken(request)) return unauthorized();
  const { externalId } = await params;
  const connection = await findManagedConnection(externalId);
  if (!connection) return NextResponse.json({ found: false }, { status: 404 });
  await deleteProviderConnection(connection.id);
  return new Response(null, { status: 204 });
}
