import { Module } from '@nestjs/common';
import { KpisController } from './kpis.controller.js';
import { KpisService } from './kpis.service.js';

@Module({ controllers: [KpisController], providers: [KpisService], exports: [KpisService] })
export class KpisModule {}
