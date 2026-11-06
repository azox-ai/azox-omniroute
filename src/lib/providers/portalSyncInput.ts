import { z } from "zod";

const metadataSchema = z.object({
  chatgptAccountId: z.string().trim().min(1).max(256).optional(),
  accountId: z.string().trim().min(1).max(256).optional(),
  organizationId: z.string().trim().min(1).max(256).optional(),
  organizationUuid: z.string().trim().min(1).max(256).optional(),
  subscriptionType: z.string().trim().min(1).max(128).optional(),
}).strict();

export const portalSyncInputSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  accessToken: z.string().min(1).max(65536).refine((value) => value.trim().length > 0),
  tokenVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  enabled: z.boolean().default(true),
  email: z.string().email().max(320).optional(),
  name: z.string().trim().min(1).max(256).optional(),
  displayName: z.string().trim().min(1).max(256).optional(),
  scope: z.string().max(2048).optional(),
  tokenType: z.enum(["Bearer", "bearer"]).optional(),
  providerSpecificData: metadataSchema.default({}),
}).strict();

export type PortalSyncInput = z.input<typeof portalSyncInputSchema>;
