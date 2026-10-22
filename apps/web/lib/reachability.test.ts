import { describe, expect, it } from 'vitest';
import { isLocalControlUrl } from './reachability';

const cmd = (url: string) => `curl ... --token t --control-url ${url}`;

describe('isLocalControlUrl', () => {
  it('flags addresses a remote VPS cannot reach', () => {
    for (const url of [
      'https://agent.localhost:8490',
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.2',
      'https://192.168.1.5',
      'https://172.20.0.1',
    ]) {
      expect(isLocalControlUrl(cmd(url)), url).toBe(true);
    }
  });

  it('accepts public names and addresses', () => {
    for (const url of ['https://agent.example.com', 'https://203.0.113.7', 'https://172.32.0.1']) {
      expect(isLocalControlUrl(cmd(url)), url).toBe(false);
    }
  });
});
