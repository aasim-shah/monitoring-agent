import { z } from 'zod';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** 32-byte ephemeral key + 12-byte nonce + at least the 16-byte tag. */
const MIN_SEALED_BYTES = 60;

export const enablePackBody = z
  .object({
    packId: z.string().max(64),
    settings: z.record(z.unknown()),
    sealedCredentials: z
      .string()
      .max(4096)
      .regex(BASE64, 'sealedCredentials must be base64')
      .refine((s) => Buffer.from(s, 'base64').length >= MIN_SEALED_BYTES, 'sealedCredentials is too short')
      .optional(),
  })
  .strict();

export const configAckBody = z
  .object({
    policyVersion: z.number().int().min(1),
    results: z
      .array(
        z
          .object({
            packId: z.string().max(64),
            status: z.enum(['applied', 'failed']),
            message: z.string().max(2000).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
