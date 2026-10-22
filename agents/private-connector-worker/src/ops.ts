import { ConnectorError, type ConnectorRegistry, type ExecutionContext } from '@pcp/connector-sdk';

/** Payload of a `connector_op` task (signed by the control plane). */
export interface ConnectorOp {
  connectionId: string;
  provider: string;
  operation: 'validate' | 'health' | 'template';
  config: Record<string, unknown>;
  template?: string;
  params?: { from: string; to: string };
}

export interface OpOutcome {
  status: 'succeeded' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export interface OpDeps {
  registry: ConnectorRegistry;
  loadSecret: (secretRef: string) => Promise<Record<string, string>>;
}

/** Runs one connector operation inside the customer network with the local secret. */
export async function runOp(op: ConnectorOp, deps: OpDeps, timeoutMs = 60_000): Promise<OpOutcome> {
  const fail = (reason: string, message: string): OpOutcome => ({
    status: 'failed',
    error: message.slice(0, 2000),
    result: { operation: op.operation, reason },
  });
  let connector;
  try {
    connector = deps.registry.get(op.provider);
  } catch {
    return fail('invalid_config', `unknown provider ${op.provider}`);
  }
  if (!connector.executionLocations.includes('private'))
    return fail('invalid_config', `${op.provider} does not run on a private worker`);
  const secretRef = typeof op.config.secretRef === 'string' ? op.config.secretRef : undefined;
  const ctx: ExecutionContext = {
    authenticatedOrganizationId: '',
    connectionId: op.connectionId,
    executionLocation: 'private',
    requestId: op.connectionId,
    deadline: new Date(Date.now() + timeoutMs).toISOString(),
    config: op.config,
    credentials: () => (secretRef ? deps.loadSecret(secretRef) : Promise.resolve({})),
  };
  try {
    switch (op.operation) {
      case 'validate': {
        const v = await connector.validate(ctx);
        return { status: 'succeeded', result: { operation: 'validate', ...v } };
      }
      case 'health': {
        if (!connector.health) return fail('invalid_config', `${op.provider} has no health check`);
        const h = await connector.health(ctx);
        return { status: 'succeeded', result: { operation: 'health', ...h } };
      }
      case 'template': {
        if (!connector.runTemplate || !op.template)
          return fail('invalid_config', `${op.provider} has no templates`);
        const r = await connector.runTemplate(ctx, op.template, op.params ?? { from: '', to: '' });
        return { status: 'succeeded', result: { operation: 'template', template: op.template, ...r } };
      }
      default:
        return fail('invalid_config', `unsupported operation ${String(op.operation)}`);
    }
  } catch (err) {
    if (err instanceof ConnectorError) return fail(err.reason, err.message);
    return fail('provider_unavailable', err instanceof Error ? err.message : String(err));
  }
}
