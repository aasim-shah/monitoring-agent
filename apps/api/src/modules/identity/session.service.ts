import type { PrismaClient } from '@pcp/database';
import { hashToken, randomToken } from './tokens.js';

export const SESSION_IDLE_MS = 12 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3_600_000;

export interface SessionRecord {
  id: string;
  userId: string;
  mfaVerified: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/** Server-side sessions; the cookie carries a random token stored only as its hash. */
export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    userId: string,
    opts: { mfaVerified: boolean },
  ): Promise<{ token: string; session: SessionRecord }> {
    const token = randomToken();
    const now = this.now();
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        mfaVerified: opts.mfaVerified,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      },
    });
    return { token, session };
  }

  /** Returns the live session for a token, refreshing its idle timer, or null. */
  async resolve(token: string): Promise<SessionRecord | null> {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    const now = this.now();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.lastSeenAt.getTime() + SESSION_IDLE_MS <= now.getTime()
    ) {
      return null;
    }
    return this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }

  async markMfaVerified(sessionId: string): Promise<void> {
    await this.prisma.session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
  }

  async revoke(token: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }
}
