import { z } from 'zod';

const severity = z.enum(['critical', 'warning', 'info']);
const params = z.record(z.string(), z.unknown());

export const createRuleBody = z
  .object({
    template: z.string().max(64),
    name: z.string().trim().min(1).max(120).optional(),
    params: params.optional(),
    severity: severity.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const updateRuleBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    params: params.optional(),
    severity: severity.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const resolveBody = z.object({ note: z.string().trim().max(2000).optional() }).strict();

export const postmortemBody = z
  .object({
    summary: z.string().trim().max(4000),
    causeCategory: z.enum([
      'capacity',
      'deployment',
      'configuration',
      'dependency',
      'infrastructure',
      'code',
      'other',
    ]),
    followUps: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict();

const name = z.string().trim().min(1).max(80);
export const createChannelBody = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('email'),
      name,
      recipients: z.array(z.string().email().max(254)).min(1).max(10),
      escalation: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('slack'),
      name,
      url: z.string().url().max(2048),
      escalation: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('webhook'),
      name,
      url: z.string().url().max(2048),
      escalation: z.boolean().optional(),
    })
    .strict(),
]);

export const updateChannelBody = z
  .object({
    name: name.optional(),
    recipients: z.array(z.string().email().max(254)).min(1).max(10).optional(),
    escalation: z.boolean().optional(),
  })
  .strict();

export const incidentListQuery = z
  .enum(['open', 'acknowledged', 'resolved', 'active', 'all'])
  .default('active');
