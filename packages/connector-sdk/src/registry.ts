import type { ConnectorCapability } from '@pcp/shared-contracts';
import type { CatalogEntry, Connector } from './types.js';

/** Capability → methods that implement it (ADR 0008). */
const METHODS: Record<ConnectorCapability, Array<keyof Connector>> = {
  authenticate: ['beginAuthorization', 'completeAuthorization'],
  config_validation: ['validateConfig'],
  validate: ['validate'],
  discover: ['discover'],
  sync: ['sync'],
  health: ['health'],
  metrics: ['collect'],
  events: ['ingestEvent'],
  webhook_registration: ['registerWebhook'],
  credential_refresh: ['refreshCredential'],
  actions: ['executeAction'],
};

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.type))
      throw new Error(`connector ${connector.type} already registered`);
    const declared = new Set(connector.capabilities());
    for (const [capability, methods] of Object.entries(METHODS) as Array<
      [ConnectorCapability, Array<keyof Connector>]
    >) {
      const implemented = methods.every((m) => typeof connector[m] === 'function');
      const partially = methods.some((m) => typeof connector[m] === 'function');
      if (declared.has(capability) && !implemented) {
        throw new Error(
          `connector ${connector.type} declares ${capability} but does not implement ${methods.join(', ')}`,
        );
      }
      if (!declared.has(capability) && partially) {
        throw new Error(
          `connector ${connector.type} implements ${methods.join(', ')} but does not declare ${capability}`,
        );
      }
    }
    this.connectors.set(connector.type, connector);
  }

  get(type: string): Connector {
    const connector = this.connectors.get(type);
    if (!connector) throw new Error(`unknown connector ${type}`);
    return connector;
  }

  has(type: string): boolean {
    return this.connectors.has(type);
  }

  list(): CatalogEntry[] {
    return [...this.connectors.values()]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((c) => ({
        type: c.type,
        version: c.version,
        displayName: c.displayName,
        capabilities: c.capabilities(),
        executionLocations: c.executionLocations,
        credentialFields: c.credentialFields,
        configSchema: c.configSchema(),
      }));
  }
}
