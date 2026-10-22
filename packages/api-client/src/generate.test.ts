import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/generate.mjs', import.meta.url));

describe('generated API types', () => {
  it('match docs/architecture/openapi-v1.yaml', () => {
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
    // Spawns the generator over the whole OpenAPI document: ~1 s alone, several under turbo's parallel load.
  }, 30_000);
});
