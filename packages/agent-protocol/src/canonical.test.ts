import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './index.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  it('is ASCII-only: escapes U+007F and above, as Go must too', () => {
    expect(canonicalJson({ b: 1, a: 'é' })).toBe('{"a":"\\u00e9","b":1}');
    expect(canonicalJson('<&> \u007f😀')).toBe('"<&>\\u2028\\u007f\\ud83d\\ude00"');
    expect(canonicalJson('line\nbreak "q" \\')).toBe('"line\\nbreak \\"q\\" \\\\"');
  });

  it('accepts only safe integers', () => {
    expect(() => canonicalJson({ n: 1.5 })).toThrow(/integer/);
    expect(() => canonicalJson({ n: 2 ** 60 })).toThrow(/integer/);
    expect(canonicalJson({ n: -42 })).toBe('{"n":-42}');
  });

  it('rejects values JSON cannot carry', () => {
    expect(() => canonicalJson({ u: undefined })).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });

  it('the shared signature vector verifies (Review Focus #4)', () => {
    const v = JSON.parse(
      readFileSync(new URL('../testdata/task-signature.json', import.meta.url), 'utf8'),
    ) as {
      publicKey: string;
      task: Record<string, unknown>;
      canonical: string;
      signature: string;
    };
    const { signature: _s, ...unsigned } = v.task;
    expect(canonicalJson(unsigned)).toBe(v.canonical);
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(v.publicKey, 'base64').toString('base64url') },
      format: 'jwk',
    });
    expect(verify(null, Buffer.from(v.canonical, 'utf8'), key, Buffer.from(v.signature, 'base64'))).toBe(
      true,
    );
    expect(v.task.signature).toBe(v.signature);
  });
});
