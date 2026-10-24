import { Module, type DynamicModule } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { GoogleConnectController } from './google-connect.controller.js';
import { GoogleConnectService } from './google-connect.service.js';
import { PrivateOpsService } from './private-ops.service.js';
import { connectorProviders } from './registry.provider.js';

@Module({})
export class ConnectionsModule {
  static register(env: Record<string, string | undefined>): DynamicModule {
    return {
      module: ConnectionsModule,
      imports: [AgentsModule, IdentityModule],
      controllers: [CatalogController, ConnectionsController, GoogleConnectController],
      providers: [...connectorProviders(env), PrivateOpsService, ConnectionsService, GoogleConnectService],
    };
  }
}
