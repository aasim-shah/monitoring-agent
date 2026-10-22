import { z } from 'zod';

export const createEnrollmentBody = z.object({
  agentType: z.enum(['host', 'private_worker']).default('host'),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresInMinutes: z.number().int().min(5).max(1440).default(60),
});
