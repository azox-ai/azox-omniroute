export function resolvePortalConnectionName(
  sponsoredLabel: string | undefined,
  accountName: string | undefined
): string | undefined {
  const sponsor = sponsoredLabel?.trim();
  return sponsor || accountName?.trim() || undefined;
}
