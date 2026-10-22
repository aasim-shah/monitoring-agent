import { z } from 'zod';

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'invalid hostname');
const repository = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/name');

export const createProductBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  domains: z.array(hostname).max(50).default([]),
  repositories: z.array(repository).max(100).default([]),
});

export const createEnvironmentBody = z.object({ name: z.string().trim().min(1).max(50) });
