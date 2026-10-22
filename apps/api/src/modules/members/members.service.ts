import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { Role, TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { hashToken, randomToken } from '../identity/tokens.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { assertRoleNotAbove } from './roles.js';

const INVITATION_TTL_MS = 7 * 24 * 3_600_000;

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  all_products: boolean;
  product_ids: string[];
  expires_at: Date;
  accepted_at: Date | null;
}

export interface MemberView {
  id: string;
  userId: string;
  email: string;
  role: Role;
  productIds: string[] | 'all';
  createdAt: Date;
}

const invalidToken = () => new ApiException(400, 'invalid_token', 'The invitation is invalid or has expired');

function memberView(m: {
  id: string;
  userId: string;
  role: Role;
  allProducts: boolean;
  productIds: string[];
  createdAt: Date;
  user: { email: string };
}): MemberView {
  return {
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    role: m.role,
    productIds: m.allProducts ? 'all' : m.productIds,
    createdAt: m.createdAt,
  };
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly audit: AuditService,
  ) {}

  async invite(ctx: TenantContext, input: { email: string; role: Role; productIds?: string[] }) {
    assertRoleNotAbove(ctx.roles[0]!, input.role);
    const token = randomToken();
    const invitation = await withTenant(this.prisma, ctx, async (tx) => {
      await this.assertProductsInOrg(tx, input.productIds);
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
      const created = await tx.invitation.create({
        data: {
          organizationId: ctx.organizationId,
          email: input.email,
          role: input.role,
          allProducts: input.productIds === undefined,
          productIds: input.productIds ?? [],
          tokenHash: hashToken(token),
          invitedByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : '',
          expiresAt: new Date(this.now().getTime() + INVITATION_TTL_MS),
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: created.id,
        metadata: { email: input.email, role: input.role },
      });
      return { ...created, organizationName: org.name };
    });
    await this.mailer.send({
      to: input.email,
      subject: `You are invited to ${invitation.organizationName}`,
      text: `You have been invited to join ${invitation.organizationName} as ${input.role}.\nAccept: ${this.config.appOrigin}/invitations/accept?token=${token}\nThe invitation expires in 7 days.`,
    });
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  async accept(user: { id: string; email: string }, requestId: string, token: string) {
    const [inv] = await this.prisma.$queryRaw<
      InvitationRow[]
    >`SELECT * FROM pcp_find_invitation(${hashToken(token)})`;
    if (!inv || inv.accepted_at || inv.expires_at <= this.now()) throw invalidToken();
    if (inv.email !== user.email) {
      throw new ApiException(403, 'email_mismatch', 'Sign in with the invited email address to accept');
    }
    const ctx: TenantContext = {
      organizationId: inv.organization_id,
      actor: { kind: 'user', userId: user.id },
      roles: [inv.role],
      productIds: 'all',
      environmentIds: 'all',
      requestId,
    };
    return withTenant(this.prisma, ctx, async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, acceptedAt: null },
        data: { acceptedAt: this.now() },
      });
      if (claimed.count !== 1) throw invalidToken();
      const existing = await tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: inv.organization_id, userId: user.id } },
      });
      if (existing)
        throw new ApiException(409, 'already_member', 'You are already a member of this organization');
      const member = await tx.organizationMember.create({
        data: {
          organizationId: inv.organization_id,
          userId: user.id,
          role: inv.role,
          allProducts: inv.all_products,
          productIds: inv.product_ids,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'member.joined',
        targetType: 'member',
        targetId: member.id,
        metadata: { invitationId: inv.id, role: inv.role },
      });
      return { organizationId: inv.organization_id, role: inv.role };
    });
  }

  list(ctx: TenantContext): Promise<MemberView[]> {
    return withTenant(this.prisma, ctx, async (tx) =>
      (
        await tx.organizationMember.findMany({
          include: { user: { select: { email: true } } },
          orderBy: { createdAt: 'asc' },
        })
      ).map(memberView),
    );
  }

  update(
    ctx: TenantContext,
    memberId: string,
    input: { role?: Role; productIds?: string[] | 'all' },
  ): Promise<MemberView> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const target = await this.loadMember(tx, memberId);
      assertRoleNotAbove(ctx.roles[0]!, target.role, ...(input.role ? [input.role] : []));
      if (target.role === 'owner' && input.role && input.role !== 'owner') await this.assertNotLastOwner(tx);
      if (Array.isArray(input.productIds)) await this.assertProductsInOrg(tx, input.productIds);
      const updated = await tx.organizationMember.update({
        where: { id: memberId },
        data: {
          role: input.role,
          ...(input.productIds === undefined
            ? {}
            : input.productIds === 'all'
              ? { allProducts: true, productIds: [] }
              : { allProducts: false, productIds: input.productIds }),
        },
        include: { user: { select: { email: true } } },
      });
      await this.audit.record(tx, ctx, {
        action: 'member.updated',
        targetType: 'member',
        targetId: memberId,
        metadata: {
          from: target.role,
          to: updated.role,
          productScopeChanged: input.productIds !== undefined,
        },
      });
      return memberView(updated);
    });
  }

  remove(ctx: TenantContext, memberId: string): Promise<void> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const target = await this.loadMember(tx, memberId);
      assertRoleNotAbove(ctx.roles[0]!, target.role);
      if (target.role === 'owner') await this.assertNotLastOwner(tx);
      await tx.organizationMember.delete({ where: { id: memberId } });
      await this.audit.record(tx, ctx, {
        action: 'member.removed',
        targetType: 'member',
        targetId: memberId,
        metadata: { userId: target.userId, role: target.role },
      });
    });
  }

  private async loadMember(tx: Prisma.TransactionClient, memberId: string) {
    // RLS limits this to the current organization; another tenant's member is simply not found.
    const member = await tx.organizationMember.findUnique({ where: { id: memberId } });
    if (!member) throw notFound();
    return member;
  }

  private async assertNotLastOwner(tx: Prisma.TransactionClient) {
    const owners = await tx.organizationMember.count({ where: { role: 'owner' } });
    if (owners <= 1)
      throw new ApiException(409, 'last_owner', 'An organization must keep at least one owner');
  }

  private async assertProductsInOrg(tx: Prisma.TransactionClient, productIds?: string[]) {
    if (!productIds?.length) return;
    const found = await tx.product.count({ where: { id: { in: productIds } } });
    if (found !== new Set(productIds).size) {
      throw new ApiException(400, 'validation_failed', 'Invalid fields: productIds');
    }
  }
}
