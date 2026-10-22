import { z } from 'zod';

const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'unknown IANA timezone' },
);

export const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: timezone.default('UTC'),
});

export const updateSettingsBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    timezone: timezone.optional(),
    settings: z
      .object({ dataRetentionDays: z.number().int().min(1).max(3650).optional() })
      .strict()
      .optional(),
  })
  .strict();
