import type { Provider } from '@nestjs/common';
import type { AgentConfig, AppConfig } from '../../config.js';
import { ApiException } from '../../common/errors.js';
import { APP_CONFIG } from '../../tokens.js';
import { AgentCa } from './ca/ca.service.js';
import { TaskSigner } from './task-signer.js';

export const AGENT_SETTINGS = Symbol('AGENT_SETTINGS');

export interface AgentSettings {
  config: AgentConfig;
  ca: AgentCa;
  signer: TaskSigner;
}

/** Null when the deployment has no agent PKI configured; enrollment then answers 503. */
export const agentSettingsProvider: Provider = {
  provide: AGENT_SETTINGS,
  inject: [APP_CONFIG],
  useFactory: async (c: AppConfig): Promise<AgentSettings | null> =>
    c.agents
      ? {
          config: c.agents,
          ca: await AgentCa.fromPem(c.agents.caCertPem, c.agents.caKeyPem, c.agents.chainPem),
          signer: TaskSigner.fromPem(c.agents.taskSigningKeyPem),
        }
      : null,
};

export function requireSettings(s: AgentSettings | null): AgentSettings {
  if (!s)
    throw new ApiException(
      503,
      'agent_enrollment_unavailable',
      'Agent enrollment is not configured on this deployment',
    );
  return s;
}
