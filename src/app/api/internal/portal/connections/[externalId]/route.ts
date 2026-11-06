import { NextResponse } from "next/server";

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { connectionCircuitBreakerName } from "@omniroute/open-sse/services/connectionCircuitBreaker.ts";
import { hasValidPortalSyncToken, isValidPortalExternalId } from "@/lib/auth/portalSync";
import {
  deletePortalManagedConnection,
  getPortalManagedConnection,
  PortalConnectionConflict,
  upsertPortalManagedConnection,
} from "@/lib/db/portalConnections";
import { resetPortalRefreshCircuit } from "@/lib/providers/portalManagedConnection";
import { portalSyncInputSchema } from "@/lib/providers/portalSyncInput";
import { getCircuitBreaker } from "@/shared/utils/circuitBreaker";

export const runtime = "nodejs";
type Context = { params: Promise<{ externalId: string }> };
const headers = { "Cache-Control": "private, no-store" };

function errorResponse(status: number, message: string) {
  return NextResponse.json(buildErrorBody(status, message), { status, headers });
}

function failure(error: unknown) {
  return error instanceof PortalConnectionConflict
    ? errorResponse(409, "Portal connection conflict")
    : errorResponse(500, "Portal connection operation failed");
}

function resetRuntime(provider: string, connectionId: string) {
  resetPortalRefreshCircuit(provider, connectionId);
  getCircuitBreaker(connectionCircuitBreakerName(provider, connectionId)).reset();
}

export async function GET(request: Request, { params }: Context) {
  if (!hasValidPortalSyncToken(request)) return errorResponse(401, "Unauthorized");
  try {
    const { externalId } = await params;
    if (!isValidPortalExternalId(externalId)) return errorResponse(400, "Invalid externalId");
    const connection = getPortalManagedConnection(externalId);
    return connection
      ? NextResponse.json(connection, { headers })
      : errorResponse(404, "Portal connection not found");
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request, { params }: Context) {
  if (!hasValidPortalSyncToken(request)) return errorResponse(401, "Unauthorized");
  try {
    const { externalId } = await params;
    if (!isValidPortalExternalId(externalId)) return errorResponse(400, "Invalid externalId");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "Invalid Portal payload");
    }
    const parsed = portalSyncInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "Invalid Portal payload");
    const result = upsertPortalManagedConnection(externalId, parsed.data);
    if (result.changed) resetRuntime(result.connection.provider, result.connection.id);
    return NextResponse.json(result.connection, { status: result.created ? 201 : 200, headers });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!hasValidPortalSyncToken(request)) return errorResponse(401, "Unauthorized");
  try {
    const { externalId } = await params;
    if (!isValidPortalExternalId(externalId)) return errorResponse(400, "Invalid externalId");
    const removed = await deletePortalManagedConnection(externalId);
    if (!removed) return errorResponse(404, "Portal connection not found");
    resetRuntime(removed.provider, removed.id);
    return new NextResponse(null, { status: 204, headers });
  } catch (error) {
    return failure(error);
  }
}
