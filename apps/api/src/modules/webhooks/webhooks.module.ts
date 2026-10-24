import { Module, type DynamicModule } from '@nestjs/common';
import { AuditingModule } from '../auditing/auditing.module.js';
import { connectorProviders } from '../connections/registry.provider.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({})
export class WebhooksModule {
  static register(env: Record<string, string | undefined>): DynamicModule {
    return {
      module: WebhooksModule,
      imports: [AuditingModule],
      controllers: [WebhooksController],
      providers: [...connectorProviders(env), WebhooksService],
    };
  }
}
