import { Global, Module, type DynamicModule } from '@nestjs/common';
import { connectorProviders, CONNECTOR_REGISTRY, CONNECTOR_RUNTIME } from './registry.provider.js';

/** The connector registry and runtime for modules outside connections (M16 provider actions). */
@Global()
@Module({})
export class ConnectorRuntimeModule {
  static register(env: Record<string, string | undefined>): DynamicModule {
    return {
      module: ConnectorRuntimeModule,
      providers: connectorProviders(env),
      exports: [CONNECTOR_RUNTIME, CONNECTOR_REGISTRY],
    };
  }
}
