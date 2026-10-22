import { Module, type DynamicModule } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { connectorProviders } from './registry.provider.js';

@Module({})
export class ConnectionsModule {
  static register(env: Record<string, string | undefined>): DynamicModule {
    return {
      module: ConnectionsModule,
      controllers: [CatalogController, ConnectionsController],
      providers: [...connectorProviders(env), ConnectionsService],
    };
  }
}
