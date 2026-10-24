import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, INSTALLER_RUNNER } from '../../tokens.js';
import { AgentsModule } from '../agents/agents.module.js';
import {
  InstallSessionsController,
  InternalInstallSessionsController,
} from './install-sessions.controller.js';
import { InstallSessionsService } from './install-sessions.service.js';
import { HttpInstallerRunner, MissingInstallerRunner } from './runner.client.js';

@Module({
  imports: [AgentsModule],
  controllers: [InstallSessionsController, InternalInstallSessionsController],
  providers: [
    {
      provide: INSTALLER_RUNNER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.installer?.runnerUrl && config.internalToken
          ? new HttpInstallerRunner(config.installer.runnerUrl, config.internalToken)
          : new MissingInstallerRunner(),
    },
    InstallSessionsService,
  ],
})
export class InstallSessionsModule {}
