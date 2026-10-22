import { z } from 'zod';
import { ROLES } from '@pcp/shared-contracts';

const productIds = z.array(z.string().uuid()).max(500);

export const createInvitationBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(ROLES),
  /** Omit for all products. */
  productIds: productIds.optional(),
});

export const acceptInvitationBody = z.object({ token: z.string().min(20).max(200) });

export const updateMemberBody = z
  .object({ role: z.enum(ROLES).optional(), productIds: z.union([productIds, z.literal('all')]).optional() })
  .refine((b) => b.role !== undefined || b.productIds !== undefined, { message: 'nothing to update' });
