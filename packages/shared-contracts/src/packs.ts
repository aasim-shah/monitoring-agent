import { z } from 'zod';
import { relationTypeSchema } from './graph.js';

export const packManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    detect: z.array(
      z
        .object({
          process: z.string().optional(),
          cmdlineContains: z.string().optional(),
          port: z.number().int().min(1).max(65535).optional(),
          systemdUnit: z.string().optional(),
          image: z.string().optional(),
        })
        .strict(),
    ),
    changeLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    credentials: z.array(z.object({ name: z.string(), hint: z.string() }).strict()),
    collector: z.object({ receivers: z.record(z.unknown()) }).strict(),
    logSources: z.array(z.string()).optional(),
    metricAllowlist: z.array(z.string()).min(1),
    dropLabels: z.array(z.string()).optional(),
    alerts: z.array(
      z
        .object({
          id: z.string(),
          description: z.string(),
          expr: z.string(),
          for: z.string(),
          severity: z.enum(['info', 'warning', 'critical']),
        })
        .strict(),
    ),
    panels: z.string(),
    graph: z
      .object({
        assetType: z.string(),
        edges: z.array(z.object({ type: relationTypeSchema, from: z.string() }).strict()),
      })
      .strict(),
    inspection: z
      .object({ allowedCommands: z.array(z.string()) })
      .strict()
      .optional(),
    guidance: z.string().optional(),
  })
  .strict();
export type PackManifest = z.infer<typeof packManifestSchema>;
