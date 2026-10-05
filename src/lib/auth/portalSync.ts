import { timingSafeEqual } from "node:crypto";

export function hasValidPortalSyncToken(request: Request): boolean {
  const expected = process.env.PORTAL_SYNC_TOKEN || "";
  const authorization = request.headers.get("authorization") || "";
  if (!expected || !authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
