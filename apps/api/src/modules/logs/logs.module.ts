import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { LogsController } from './logs.controller.js';
import { TailService } from './tail.service.js';

@Module({ imports: [AgentsModule], controllers: [LogsController], providers: [TailService] })
export class LogsModule {}
