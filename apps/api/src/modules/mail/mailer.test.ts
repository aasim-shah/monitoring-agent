import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from './mailer.js';

// A server that accepts connections and never answers: what a firewalled or stuck SMTP
// relay looks like. Sign-up waits on mail, so a send must fail fast instead of hanging.
let silent: Server;
let port = 0;

beforeAll(async () => {
  silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  port = (silent.address() as { port: number }).port;
});

afterAll(() => {
  silent.close();
});

describe('SmtpMailer', () => {
  it('gives up on an SMTP server that never answers', async () => {
    const mailer = new SmtpMailer(`smtp://127.0.0.1:${port}`, 'PCP <alerts@example.com>', { timeoutMs: 300 });
    const started = Date.now();
    await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('defaults to a 10 s limit, not nodemailer’s 2 minutes', () => {
    const mailer = new SmtpMailer(`smtp://127.0.0.1:${port}`, 'PCP <alerts@example.com>');
    expect(mailer.timeoutMs).toBe(10_000);
  });
});
