/** Deterministic BullMQ job ID: one queued job per kind, tenant, entity (and window). BullMQ forbids ':' in IDs. */
export function jobId(kind: string, organizationId: string, entityId: string, window?: string): string {
  return [kind, organizationId, entityId, window].filter(Boolean).join('__');
}
