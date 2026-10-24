import { z } from 'zod';

export const createConnectionBody = z.object({
  provider: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(100),
  executionLocation: z.enum(['cloud', 'private']),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const authorizeBody = z.object({
  credentials: z.record(z.string(), z.string().min(1).max(16_384)),
});

export const resourceScopesBody = z.object({
  scopes: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(512),
        resourceType: z.string().trim().min(1).max(64),
        name: z.string().trim().min(1).max(256),
        productId: z.string().uuid(),
        environmentId: z.string().uuid().optional(),
      }),
    )
    .max(500),
});

/** A template's time window; empty strings for templates without one. */
export const templateRunBody = z
  .object({
    from: z.union([z.string().datetime(), z.literal('')]),
    to: z.union([z.string().datetime(), z.literal('')]),
  })
  .strict();
