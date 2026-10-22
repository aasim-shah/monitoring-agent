import { Controller, Get } from '@nestjs/common';
import { SessionOnly } from '../../common/decorators.js';
import { ConnectionsService } from './connections.service.js';

@Controller('api/v1/connectors')
export class CatalogController {
  constructor(private readonly connections: ConnectionsService) {}

  @SessionOnly()
  @Get('catalog')
  catalog() {
    return { connectors: this.connections.catalog() };
  }
}
