import { Controller, Get, Inject } from '@nestjs/common';
import { SessionOnly } from '../../common/decorators.js';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../tokens.js';
import { ConnectionsService } from './connections.service.js';

@Controller('api/v1/connectors')
export class CatalogController {
  constructor(
    private readonly connections: ConnectionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @SessionOnly()
  @Get('catalog')
  catalog() {
    return {
      connectors: this.connections.catalog(),
      // Managed databases (e.g. MongoDB Atlas network access) allowlist this address.
      egressIp: this.config.platformEgressIp ?? null,
    };
  }
}
