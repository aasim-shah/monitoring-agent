import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';

export interface ReauthNoticeDeps {
  prisma: PrismaClient;
  appOrigin: string;
  sendMail(mail: { to: string[]; subject: string; text: string; html: string }): Promise<void>;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Tells the member who connected a provider, and the organization's owners, that its access was
 * revoked (WB-08 UC-08-10). The processor calls this once per revocation; sync stays stopped and
 * history stays until someone reconnects.
 */
export function reauthorizationNotice(deps: ReauthNoticeDeps) {
  return async (ctx: TenantContext, connectionId: string) => {
    const found = await withTenant(deps.prisma, ctx, async (tx) => {
      const c = await tx.connection.findUnique({
        where: { id: connectionId },
        include: { scopes: { select: { productId: true }, take: 1 } },
      });
      if (!c) return null;
      const members = await tx.organizationMember.findMany({
        where: {
          organizationId: ctx.organizationId,
          OR: [{ role: 'owner' }, ...(c.createdByUserId ? [{ userId: c.createdByUserId }] : [])],
        },
        include: { user: { select: { email: true } } },
      });
      return { c, emails: [...new Set(members.map((m) => m.user.email))].sort() };
    });
    if (!found || !found.emails.length) return;
    const { c, emails } = found;
    const productId = c.scopes[0]?.productId;
    const link = productId
      ? `${deps.appOrigin}/orgs/${ctx.organizationId}/products/${productId}/integrations/${c.id}`
      : `${deps.appOrigin}/orgs/${ctx.organizationId}`;
    const who = c.accountEmail ? ` (granted by ${c.accountEmail})` : '';
    const text = [
      `${c.displayName}${who} needs reauthorization: the provider no longer accepts the stored access.`,
      'Syncing has stopped. Data collected so far is kept; nothing is shown as zero for the missing days.',
      `Reconnect: ${link}`,
    ].join('\n\n');
    await deps.sendMail({
      to: emails,
      subject: `${c.displayName} connection needs reauthorization`,
      text,
      html: text
        .split('\n\n')
        .map((p) => `<p>${escape(p)}</p>`)
        .join(''),
    });
  };
}
