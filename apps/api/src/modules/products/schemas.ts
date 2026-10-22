import { z } from 'zod';

/** "https://www.example.com/path" → "www.example.com"; a bare hostname passes through. */
function toHostname(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '');
}

/** GitHub URL or SSH remote → "owner/name"; "owner/name" passes through. */
function toRepository(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

const hostname = z.preprocess(
  toHostname,
  z
    .string()
    .toLowerCase()
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'invalid hostname'),
);
const repository = z.preprocess(
  toRepository,
  z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/name'),
);

export const createProductBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  domains: z.array(hostname).max(50).default([]),
  repositories: z.array(repository).max(100).default([]),
});

export const createEnvironmentBody = z.object({ name: z.string().trim().min(1).max(50) });
