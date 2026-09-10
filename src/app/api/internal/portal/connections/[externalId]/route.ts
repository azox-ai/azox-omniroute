import { NextResponse } from "next/server";
import { hasValidPortalSyncToken } from "@/lib/auth/portalSync";
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/models";

const ALLOWED_PROVIDERS = new Set(["claude", "codex"]);

async function findManagedConnection(externalId: string) {
  const connections = await getProviderConnections();
  return (
    connections.find(
      (connection) => connection.providerSpecificData?.portalExternalId === externalId
    ) || null
  );
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
  let input;
  try {
    input = normalizeBody(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }
  const existing = await findManagedConnection(externalId);
  const currentVersion = Number(existing?.providerSpecificData?.portalTokenVersion || 0);
  if (existing && input.tokenVersion < currentVersion)
    return NextResponse.json(
      { error: "Stale tokenVersion", tokenVersion: currentVersion },
      { status: 409 }
    );
  if (existing && existing.provider !== input.provider)
    return NextResponse.json({ error: "Provider cannot be changed" }, { status: 409 });
  if (existing && input.tokenVersion === currentVersion)
    return NextResponse.json({
      id: existing.id,
      provider: existing.provider,
      enabled: existing.isActive !== false,
      expiresAt: existing.expiresAt || null,
      tokenVersion: currentVersion,
    });
  const values = {
    provider: input.provider,
    authType: "oauth",
    accessToken: input.accessToken,
    expiresAt: input.expiresAt,
    testStatus: "active",
    isActive: input.enabled,
    providerSpecificData: {
      ...(existing?.providerSpecificData || {}),
      ...input.providerSpecificData,
      portalExternalId: externalId,
      portalTokenVersion: input.tokenVersion,
    },
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.idToken ? { idToken: input.idToken } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.tokenType ? { tokenType: input.tokenType } : {}),
  };
  const connection = existing
    ? await updateProviderConnection(existing.id, { ...values, refreshToken: undefined })
    : await createProviderConnection(values);
  return NextResponse.json({
    id: connection?.id,
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
