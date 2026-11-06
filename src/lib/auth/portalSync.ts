import { createHash, timingSafeEqual } from "node:crypto";

export function isValidPortalExternalId(externalId: unknown): externalId is string {
  return typeof externalId === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(externalId);
}

export function isPortalSyncPath(pathname: string): boolean {
  const match = /^\/api\/internal\/portal\/connections\/([^/]+)$/.exec(pathname);
  return Boolean(match && isValidPortalExternalId(match[1]));
}

export function hasExactPortalSyncPath(
  request: { url?: string; nextUrl?: { pathname?: string | null } | null },
  normalizedPath: string
): boolean {
  if (!isPortalSyncPath(normalizedPath)) return false;
  const paths: string[] = [];
  if (request.url !== undefined) {
    try {
      paths.push(new URL(request.url).pathname);
    } catch {
      return false;
    }
  }
  const nextPath = request.nextUrl?.pathname;
  if (nextPath !== undefined && nextPath !== null) paths.push(nextPath);
  return paths.length > 0 && paths.every((pathname) =>
    pathname === normalizedPath && isPortalSyncPath(pathname)
  );
}

export function hasValidPortalSyncToken(request: { headers: Headers }): boolean {
  const expected = process.env.PORTAL_SYNC_TOKEN;
  if (!expected || !expected.trim()) return false;
  const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(expectedHash, providedHash);
}
