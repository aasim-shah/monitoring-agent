import { z } from 'zod';

export const ASSET_LIFECYCLES = [
  'discovered',
  'active',
  'unreachable',
  'missing',
  'retired',
  'manually_managed',
] as const;
export type AssetLifecycle = (typeof ASSET_LIFECYCLES)[number];

export const RELATION_TYPES = [
  'DEPENDS_ON',
  'ROUTES_TO',
  'DEPLOYED_ON',
  'DEPLOYS',
  'CONNECTS_TO',
  'MONITORED_BY',
  'AUTHENTICATES_WITH',
  'USES_SDK',
  'PRODUCES_DATA_FOR',
  'TRIGGERED_BY',
  'OWNED_BY',
  'EXPOSES_ENDPOINT',
  'HOSTS',
  'REPORTS_TO',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
export const relationTypeSchema = z.enum(RELATION_TYPES);

export const VERIFICATION_STATES = ['proposed', 'verified', 'rejected', 'drifted'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const IMPACT_CLASSES = ['confirmed', 'potential', 'unknown'] as const;
export type ImpactClass = (typeof IMPACT_CLASSES)[number];
