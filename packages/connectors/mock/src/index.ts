import {
  ConnectorError,
  hmacSha256Hex,
  safeEqual,
  type Connector,
  type ExecutionContext,
} from '@pcp/connector-sdk';

// Test-only connector (ADR 0008): never registered in production.

const BEHAVIORS = ['ok', 'unauthorized', 'forbidden', 'rate_limited', 'unavailable', 'leaky'] as const;
type Behavior = (typeof BEHAVIORS)[number];

const behavior = (ctx: ExecutionContext): Behavior => (ctx.config.behavior as Behavior | undefined) ?? 'ok';

async function failFor(ctx: ExecutionContext): Promise<void> {
  switch (behavior(ctx)) {
    case 'unauthorized':
      throw new ConnectorError('reauthorization_required', 'mock token rejected');
    case 'rate_limited':
      throw new ConnectorError('rate_limited', 'mock rate limit', { retryAfterSeconds: 30 });
    case 'unavailable':
      throw new ConnectorError('provider_unavailable', 'mock provider down');
    case 'leaky': {
      const { token } = await ctx.credentials();
      throw new Error(`upstream rejected token ${token}`);
    }
    default:
  }
}

export const mockConnector: Connector = {
  type: 'mock',
  version: '1.0.0',
  displayName: 'Mock (tests only)',
  executionLocations: ['cloud', 'private'],
  credentialFields: [
    { name: 'token', label: 'Token', secret: true },
    { name: 'webhookSecret', label: 'Webhook secret', secret: true, required: false },
  ],
  capabilities: () => ['config_validation', 'validate', 'discover', 'health', 'events', 'sync'],
  configSchema: () => ({
    type: 'object',
    properties: {
      behavior: { enum: [...BEHAVIORS] },
      resources: { type: 'integer', minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  }),
  validateConfig(config) {
    const c = (config ?? {}) as Record<string, unknown>;
    const errors: string[] = [];
    if (c.behavior !== undefined && !BEHAVIORS.includes(c.behavior as Behavior)) errors.push('behavior');
    if (
      c.resources !== undefined &&
      !(Number.isInteger(c.resources) && (c.resources as number) >= 0 && (c.resources as number) <= 100)
    ) {
      errors.push('resources');
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  async validate(ctx) {
    await failFor(ctx);
    if (behavior(ctx) === 'forbidden') return { ok: false, missingPermissions: ['mock:read'] };
    return { ok: true, accountId: 'mock-account' };
  },
  async discover(ctx) {
    await failFor(ctx);
    const count = (ctx.config.resources as number | undefined) ?? 2;
    return {
      observations: Array.from({ length: count }, (_, i) => ({
        connectionId: ctx.connectionId,
        source: 'provider_api' as const,
        provider: 'mock',
        resourceType: 'mock_resource',
        externalId: `mock-${i + 1}`,
        attributes: { name: `Mock resource ${i + 1}` },
        observedAt: new Date().toISOString(),
        method: 'provider_api',
        confidence: 0.95,
        evidence: {},
      })),
    };
  },
  async health(ctx) {
    await failFor(ctx);
    return { ok: true };
  },
  /** One point per scoped resource; the value is the look-back, the gaps echo the granted scopes. */
  async sync(ctx, input) {
    await failFor(ctx);
    return {
      points: input.scopes.map((s) => ({
        resourceType: s.resourceType,
        externalId: s.externalId,
        metric: 'mock_days',
        day: '2026-10-24',
        value: input.days,
        completeness: 'complete' as const,
      })),
      gaps: (ctx.grantedScopes ?? []).map((g) => `granted: ${g}`),
    };
  },
  /** `x-mock-signature: sha256=<hex HMAC of the body>`, `x-mock-delivery`, `x-mock-event`. */
  verifyWebhook(req, credentials) {
    const secret = credentials.webhookSecret;
    const sent = req.headers['x-mock-signature'] ?? '';
    if (!secret || !safeEqual(sent, `sha256=${hmacSha256Hex(secret, req.rawBody)}`)) return { ok: false };
    return {
      ok: true,
      deliveryId: req.headers['x-mock-delivery'] ?? '',
      eventType: req.headers['x-mock-event'] ?? 'event',
    };
  },
  async ingestEvent(ctx, event) {
    const p = (event.payload ?? {}) as {
      id?: string;
      kind?: string;
      title?: string;
      at?: string;
      revoke?: boolean;
    };
    const base = {
      connectionId: ctx.connectionId,
      source: 'webhook' as const,
      provider: 'mock',
      observedAt: new Date().toISOString(),
      method: 'webhook',
      confidence: 1,
      evidence: { eventType: event.eventType },
    };
    if (p.revoke) return [{ ...base, resourceType: 'connection_revoked', attributes: {} }];
    if (!p.kind) return [];
    return [
      {
        ...base,
        resourceType: 'change_event',
        externalId: p.id,
        attributes: {
          kind: p.kind,
          title: p.title ?? p.kind,
          occurredAt: p.at ?? base.observedAt,
          externalId: p.id,
        },
      },
    ];
  },
};
