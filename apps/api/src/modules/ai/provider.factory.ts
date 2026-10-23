import {
  providerFromConfig,
  scripted,
  type ChatProvider,
  type ChatRequest,
  type ScriptStep,
} from '@pcp/ai-orchestrator';
import type { AppConfig } from '../../config.js';

const ASSET = /asset ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * The deterministic stand-in for tests and the e2e stack (PCP_AI_FAKE=1). It picks tools from
 * the question and cites every evidence ID it received, without numbers of its own.
 */
function fakeStep(req: ChatRequest): ScriptStep {
  const question = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const results = req.messages.filter((m) => m.role === 'tool');
  if (results.length === 0) {
    const asset = ASSET.exec(question);
    if (asset) return { toolCalls: [{ name: 'getAssetDetails', arguments: { assetId: asset[1] } }] };
    if (/products/i.test(question)) return { toolCalls: [{ name: 'listProducts', arguments: {} }] };
    if (/website|site up/i.test(question))
      return { toolCalls: [{ name: 'getWebsiteAvailability', arguments: { range: '24h' } }] };
    return {
      toolCalls: [
        { name: 'getIncidents', arguments: { status: 'all' } },
        { name: 'getInfrastructureMetrics', arguments: { range: '24h' } },
        { name: 'getDeployments', arguments: {} },
      ],
    };
  }
  const ids = results
    .map((m) => (JSON.parse(m.content) as { evidenceId?: string }).evidenceId)
    .filter(Boolean);
  return {
    text:
      `Finding 1 (confidence: medium): I checked the available evidence ${ids.map((id) => `[${id}]`).join(' ')}.\n` +
      '  Not established: anything beyond what these sources show.\n' +
      'Missing evidence: see the list below.',
  };
}

/** Primary then fallback from the platform config; null when no provider is configured. */
export function buildProvider(config: AppConfig): ChatProvider | null {
  if (config.ai.fake) return { ...scripted('scripted', (req) => fakeStep(req)), id: 'scripted' };
  return providerFromConfig(config.ai.providers);
}
