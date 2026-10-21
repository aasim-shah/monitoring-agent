import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import { decryptSecret, deserializeSecret, encryptSecret, serializeSecret, type KeyRing } from '@pcp/secrets';
import { ApiException } from '../../common/errors.js';
import { CLOCK, KEY_RING, PRISMA } from '../../tokens.js';
import { SessionService } from './session.service.js';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import { hashToken } from './tokens.js';

const RECOVERY_CODES = 10;
const aad = (userId: string) => `user:${userId}:mfa`;
const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, '');
const invalidCode = () => new ApiException(401, 'invalid_mfa_code', 'The code is not valid');

@Injectable()
export class MfaService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(KEY_RING) private readonly keys: KeyRing,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly sessions: SessionService,
  ) {}

  async enroll(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabledAt)
      throw new ApiException(409, 'mfa_already_enabled', 'Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaPendingSecret: this.seal(userId, secret) },
    });
    return { secret, otpauthUri: otpauthUri(secret, email) };
  }

  /** Activates a pending enrollment (returns recovery codes once) or verifies the session's second factor. */
  async verify(
    userId: string,
    sessionId: string,
    input: { code?: string; recoveryCode?: string },
  ): Promise<{ recoveryCodes?: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const unix = Math.floor(this.now().getTime() / 1000);

    if (!user.mfaEnabledAt) {
      if (!user.mfaPendingSecret || !input.code) {
        throw new ApiException(400, 'mfa_not_enrolled', 'Start enrollment first');
      }
      if (!verifyTotp(this.open(userId, user.mfaPendingSecret), input.code, unix)) throw invalidCode();
      const codes = Array.from({ length: RECOVERY_CODES }, () => {
        const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
        return `${raw.slice(0, 5)}-${raw.slice(5)}`;
      });
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { mfaSecret: user.mfaPendingSecret, mfaPendingSecret: null, mfaEnabledAt: this.now() },
        }),
        this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
        this.prisma.mfaRecoveryCode.createMany({
          data: codes.map((c) => ({ userId, codeHash: hashToken(normalizeRecoveryCode(c)) })),
        }),
      ]);
      await this.sessions.markMfaVerified(sessionId);
      return { recoveryCodes: codes };
    }

    if (input.code) {
      if (!verifyTotp(this.open(userId, user.mfaSecret!), input.code, unix)) throw invalidCode();
    } else {
      const used = await this.prisma.mfaRecoveryCode.updateMany({
        where: { userId, codeHash: hashToken(normalizeRecoveryCode(input.recoveryCode!)), usedAt: null },
        data: { usedAt: this.now() },
      });
      if (used.count !== 1) throw invalidCode();
    }
    await this.sessions.markMfaVerified(sessionId);
    return {};
  }

  private seal(userId: string, secret: string): string {
    return serializeSecret(encryptSecret(Buffer.from(secret), aad(userId), this.keys.active));
  }

  private open(userId: string, sealed: string): string {
    return decryptSecret(deserializeSecret(sealed), aad(userId), this.keys.ring).toString();
  }
}
