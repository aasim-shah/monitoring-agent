import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import { ApiException } from '../../common/errors.js';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { hashPassword, verifyPassword } from './password.js';
import { SessionService } from './session.service.js';
import { hashToken, randomToken } from './tokens.js';

const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 3_600_000;

const invalidToken = () => new ApiException(400, 'invalid_token', 'The link is invalid or has expired');

@Injectable()
export class AuthService {
  /** Hash checked when the email is unknown, so timing does not reveal registered accounts. */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly sessions: SessionService,
  ) {}

  async signup(email: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerifiedAt) {
      await this.mailer.send({
        to: email,
        subject: 'Sign-up attempt for your account',
        text: `Someone tried to create an account with this email. If it was you, sign in or reset your password at ${this.config.appOrigin}/reset.`,
      });
      return;
    }
    const user = existing ?? (await this.prisma.user.create({ data: { email, passwordHash } }));
    await this.sendEmailToken(user.id, email, 'verify');
  }

  async verifyEmail(token: string): Promise<void> {
    const row = await this.consumeToken(token, 'verify');
    await this.prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: this.now() } });
  }

  async login(email: string, password: string): Promise<{ token: string; mfaRequired: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user?.passwordHash
      ? await verifyPassword(user.passwordHash, password)
      : (await verifyPassword(await this.getDummyHash(), password), false);
    if (!user || !ok) throw new ApiException(401, 'invalid_credentials', 'Email or password is incorrect');
    if (!user.emailVerifiedAt)
      throw new ApiException(403, 'email_not_verified', 'Verify your email before signing in');
    const mfaRequired = Boolean(user.mfaEnabledAt);
    const { token } = await this.sessions.create(user.id, { mfaVerified: !mfaRequired });
    return { token, mfaRequired };
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user) await this.sendEmailToken(user.id, email, 'reset');
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const row = await this.consumeToken(token, 'reset');
    await this.prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash: await hashPassword(password) },
    });
    await this.sessions.revokeAllForUser(row.userId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.prisma.$queryRaw<
      {
        organization_id: string;
        organization_name: string;
        role: string;
        all_products: boolean;
        product_ids: string[];
      }[]
    >`SELECT * FROM pcp_user_memberships(${userId}::uuid)`;
    return {
      user: { id: user.id, email: user.email, mfaEnabled: Boolean(user.mfaEnabledAt) },
      memberships: memberships.map((m) => ({
        organizationId: m.organization_id,
        organizationName: m.organization_name,
        role: m.role,
        productIds: m.all_products ? 'all' : m.product_ids,
      })),
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomToken());
    return this.dummyHash;
  }

  private async sendEmailToken(userId: string, email: string, kind: 'verify' | 'reset'): Promise<void> {
    const token = randomToken();
    const ttl = kind === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS;
    await this.prisma.emailToken.create({
      data: { userId, kind, tokenHash: hashToken(token), expiresAt: new Date(this.now().getTime() + ttl) },
    });
    const link = `${this.config.appOrigin}/${kind === 'verify' ? 'verify' : 'reset'}?token=${token}`;
    await this.mailer.send(
      kind === 'verify'
        ? {
            to: email,
            subject: 'Verify your email',
            text: `Open this link to verify your email: ${link}\nIt expires in 24 hours.`,
          }
        : {
            to: email,
            subject: 'Reset your password',
            text: `Open this link to choose a new password: ${link}\nIt expires in 1 hour.`,
          },
    );
  }

  private async consumeToken(token: string, kind: 'verify' | 'reset') {
    const row = await this.prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.kind !== kind || row.usedAt || row.expiresAt <= this.now()) throw invalidToken();
    const claimed = await this.prisma.emailToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: this.now() },
    });
    if (claimed.count !== 1) throw invalidToken();
    return row;
  }
}
