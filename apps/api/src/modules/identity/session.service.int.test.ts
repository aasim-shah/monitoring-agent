import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/test-support';
import { SessionService } from './session.service.js';

let db: TestDatabase;
let prisma: PrismaClient;
let now = new Date('2026-10-22T08:00:00Z');
const clock = () => now;
const advance = (ms: number) => (now = new Date(now.getTime() + ms));
const HOUR = 3_600_000;

async function user() {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com` } });
}

beforeAll(async () => {
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
});

describe('SessionService', () => {
  it('creates a session stored only as a hash and resolves it', async () => {
    const svc = new SessionService(prisma, clock);
    const u = await user();
    const { token, session } = await svc.create(u.id, { mfaVerified: false });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.tokenHash).not.toContain(token);
    expect((await svc.resolve(token))?.userId).toBe(u.id);
  });

  it('expires after 12 h idle', async () => {
    const svc = new SessionService(prisma, clock);
    const { token } = await svc.create((await user()).id, { mfaVerified: false });
    advance(11 * HOUR);
    expect(await svc.resolve(token)).not.toBeNull();
    advance(11 * HOUR); // 11 h since last use
    expect(await svc.resolve(token)).not.toBeNull();
    advance(12 * HOUR + 1);
    expect(await svc.resolve(token)).toBeNull();
  });

  it('expires 7 days after creation even when active', async () => {
    const svc = new SessionService(prisma, clock);
    const { token } = await svc.create((await user()).id, { mfaVerified: false });
    for (let i = 0; i < 15; i++) {
      advance(11 * HOUR);
      expect(await svc.resolve(token)).not.toBeNull(); // 165 h, never idle > 12 h
    }
    advance(4 * HOUR); // 169 h > 168 h (7 days)
    expect(await svc.resolve(token)).toBeNull();
  });

  it('revokes one session or all sessions of a user', async () => {
    const svc = new SessionService(prisma, clock);
    const u = await user();
    const a = await svc.create(u.id, { mfaVerified: false });
    const b = await svc.create(u.id, { mfaVerified: false });
    await svc.revoke(a.token);
    expect(await svc.resolve(a.token)).toBeNull();
    expect(await svc.resolve(b.token)).not.toBeNull();
    await svc.revokeAllForUser(u.id);
    expect(await svc.resolve(b.token)).toBeNull();
  });

  it('marks a session MFA-verified', async () => {
    const svc = new SessionService(prisma, clock);
    const { token, session } = await svc.create((await user()).id, { mfaVerified: false });
    await svc.markMfaVerified(session.id);
    expect((await svc.resolve(token))?.mfaVerified).toBe(true);
  });

  it('returns null for unknown tokens', async () => {
    expect(await new SessionService(prisma, clock).resolve('nope')).toBeNull();
  });
});
