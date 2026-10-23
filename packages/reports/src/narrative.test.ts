import { ProviderError, scripted } from '@pcp/ai-orchestrator';
import { describe, expect, it } from 'vitest';
import { fixtureSources } from './fixtures.js';
import { narrate } from './narrative.js';
import { buildSnapshot } from './snapshot.js';
import { reportWindow } from './window.js';

const w = reportWindow('Europe/Berlin', new Date('2026-10-26T07:00:00Z'));
const snapshot = () => buildSnapshot(fixtureSources(), w);

describe('narrate (BR-15-02, BR-15-03, UC-15-05)', () => {
  it('keeps a summary whose numbers and citations match the snapshot', async () => {
    const provider = scripted('fake', [
      {
        text: 'CPU averaged 72 % on vps-1 [S3], up from the day before [S10]. 1 critical incident is open [S2].',
      },
    ]);
    const r = await narrate(await snapshot(), provider, { disabled: false });
    expect(r).toEqual({ text: expect.stringContaining('[S3]'), status: 'verified', problems: [] });
  });

  it('TC-15-05: a number not in the snapshot is rejected, retried once, then deferred', async () => {
    const provider = scripted('fake', [{ text: 'CPU averaged 91 % [S3].' }]);
    const r = await narrate(await snapshot(), provider, { disabled: false });
    expect(r.status).toBe('deferred');
    expect(r.text).toBeNull();
    expect(r.problems).toContain('91 does not appear in the evidence');
    expect(provider.requests).toHaveLength(2);
  });

  it('rejects a citation that is not a section', async () => {
    const provider = scripted('fake', [{ text: 'All quiet [S13].' }]);
    expect((await narrate(await snapshot(), provider, { disabled: false })).problems).toContain(
      'S13 is not an evidence ID',
    );
  });

  it('TC-15-04: a provider that fails gives a deferred narrative, not an error', async () => {
    const down = {
      id: 'down',
      model: 'm',
      chat: async () => {
        throw new ProviderError('gemini answered HTTP 503', true, 503);
      },
    };
    expect(await narrate(await snapshot(), down, { disabled: false })).toEqual({
      text: null,
      status: 'deferred',
      problems: ['AI provider unavailable: gemini answered HTTP 503'],
    });
  });

  it('does not call the provider when AI is off or not configured', async () => {
    const provider = scripted('fake', [{ text: 'x' }]);
    expect(await narrate(await snapshot(), provider, { disabled: true })).toEqual({
      text: null,
      status: 'disabled',
      problems: [],
    });
    expect(await narrate(await snapshot(), null, { disabled: false })).toMatchObject({ status: 'disabled' });
    expect(provider.requests).toHaveLength(0);
  });

  it('sends the sanitized snapshot only (BR-15-02)', async () => {
    const provider = scripted('fake', [{ text: 'Quiet day [S2].' }]);
    await narrate(await snapshot(), provider, { disabled: false });
    const sent = JSON.stringify(provider.requests[0]!.messages);
    expect(sent).toContain('vps-1');
    expect(sent).not.toContain('secret-value');
    expect(provider.requests[0]!.tools).toEqual([]);
  });
});
