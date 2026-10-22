import { describe, expect, it } from 'vitest';
import { createProductBody } from './schemas.js';

const parse = (input: { domains?: string[]; repositories?: string[] }) =>
  createProductBody.safeParse({ name: 'getRestro', ...input });

describe('createProductBody', () => {
  it('accepts website URLs and stores the hostname', () => {
    const r = parse({
      domains: ['https://getrestro.com', 'http://www.GetRestro.com/menu?x=1', 'api.getrestro.com/'],
    });
    expect(r.success && r.data.domains).toEqual(['getrestro.com', 'www.getrestro.com', 'api.getrestro.com']);
  });

  it('accepts GitHub URLs and stores owner/name', () => {
    const r = parse({
      repositories: [
        'https://github.com/aasim-shah/getrestro_backend_server',
        'github.com/aasim-shah/getrestro_react_app.git',
        'git@github.com:aasim-shah/tools.git',
        'aasim-shah/plain',
      ],
    });
    expect(r.success && r.data.repositories).toEqual([
      'aasim-shah/getrestro_backend_server',
      'aasim-shah/getrestro_react_app',
      'aasim-shah/tools',
      'aasim-shah/plain',
    ]);
  });

  it('still rejects values that are not hostnames or repositories', () => {
    expect(parse({ domains: ['not a domain'] }).success).toBe(false);
    expect(parse({ repositories: ['https://github.com/only-owner'] }).success).toBe(false);
  });
});
