import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chain } from './chain.js';
import { openAiCompatible } from './openai-compatible.js';
import { scripted } from './scripted.js';
import { ProviderError, type ChatRequest } from './types.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const KEY = 'sk-secret-test-key-0123456789';

let server: Server;
let base = '';
const requests: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
let reply: { status: number; body: string; delayMs?: number } = { status: 200, body: '{}' };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      setTimeout(() => {
        res.statusCode = reply.status;
        res.setHeader('content-type', 'application/json');
        res.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const request: ChatRequest = {
  messages: [
    { role: 'system', content: 'Use tools.' },
    { role: 'user', content: 'CPU of vps-1?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'listAssets', arguments: { type: 'host' } }],
    },
    { role: 'tool', toolCallId: 'c1', content: '{"assets":[]}' },
  ],
  tools: [
    {
      name: 'getInfrastructureMetrics',
      description: 'Host metrics',
      parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
    },
  ],
};

describe('openAiCompatible (recorded Gemini and Groq responses, TC-14-08)', () => {
  it.each(['gemini', 'groq'])('maps a recorded %s tool call', async (name) => {
    reply = { status: 200, body: fixture(`${name}-tool-call.json`) };
    const p = openAiCompatible({ id: name, baseUrl: base, apiKey: KEY, model: 'm1' });
    const res = await p.chat(request);
    expect(res.toolCalls).toEqual([
      { id: expect.any(String), name: 'getInfrastructureMetrics', arguments: { host: 'vps-1', range: '1h' } },
    ]);
    const sent = requests.at(-1)!;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(sent.body).toMatchObject({
      model: 'm1',
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'getInfrastructureMetrics' } }],
    });
    const msgs = sent.body.messages as Array<Record<string, unknown>>;
    expect(msgs[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'listAssets', arguments: '{"type":"host"}' } },
      ],
    });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"assets":[]}' });
  });

  it('returns final text, and turns malformed arguments into an error the loop can report', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Finding 1 [E1].' } }] }),
    };
    const p = openAiCompatible({ id: 'x', baseUrl: base, apiKey: KEY, model: 'm' });
    expect(await p.chat(request)).toEqual({ text: 'Finding 1 [E1].', toolCalls: [] });
    reply = {
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 't', type: 'function', function: { name: 'listAssets', arguments: '{not json' } },
              ],
            },
          },
        ],
      }),
    };
    const res = await p.chat(request);
    expect(res.toolCalls).toEqual([
      { id: 't', name: 'listAssets', arguments: {}, error: 'arguments are not valid JSON' },
    ]);
  });

  it('classifies failures as retryable or not, and never leaks the key', async () => {
    const p = openAiCompatible({ id: 'x', baseUrl: base, apiKey: KEY, model: 'm', timeoutMs: 200 });
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      reply = { status, body: JSON.stringify({ error: { message: `bad ${KEY}` } }) };
      const err = await p.chat(request).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable, String(status)).toBe(retryable);
      expect(err.message).not.toContain(KEY);
    }
    reply = { status: 200, body: '{}', delayMs: 500 };
    const timeout = await p.chat(request).catch((e) => e);
    expect(timeout).toMatchObject({ retryable: true });
    expect(timeout.message).toMatch(/timed out/);
  });
});

describe('chain (Review Focus #3)', () => {
  it('falls back on retryable failures and reports who answered', async () => {
    const down = scripted('gemini', [{ error: { status: 429 } }]);
    const up = scripted('groq', [{ text: 'ok' }]);
    const res = await chain([down, up]).chat(request);
    expect(res).toMatchObject({ text: 'ok', provider: 'groq' });
  });

  it('does not fall back on a request error, and reports when every provider failed', async () => {
    const bad = scripted('gemini', [{ error: { status: 400 } }]);
    const never = scripted('groq', [{ text: 'should not be used' }]);
    await expect(chain([bad, never]).chat(request)).rejects.toMatchObject({ retryable: false });
    const all = chain([
      scripted('gemini', [{ error: { status: 503 } }]),
      scripted('groq', [{ error: { status: 500 } }]),
    ]);
    await expect(all.chat(request)).rejects.toThrow(/AI provider unavailable/);
  });
});
