import type { Prisma } from '@pcp/database';
import { decryptSecret, deserializeSecret, encryptSecret, serializeSecret, type KeyRing } from '@pcp/secrets';
import type { TenantContext } from '@pcp/shared-contracts';

/** AAD binds the ciphertext to its organization and connection (ADR 0004). */
export const credentialsAad = (organizationId: string, connectionId: string) =>
  `${organizationId}:${connectionId}`;

/** Encrypts and stores (or replaces) a connection's credentials inside the caller's tenant transaction. */
export async function storeCredentials(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  connectionId: string,
  credentials: Record<string, string>,
  keys: KeyRing,
): Promise<void> {
  const sealed = encryptSecret(
    Buffer.from(JSON.stringify(credentials)),
    credentialsAad(ctx.organizationId, connectionId),
    keys.active,
  );
  const data = { ciphertext: serializeSecret(sealed), keyVersion: sealed.keyVersion };
  await tx.connectionSecret.upsert({
    where: { connectionId },
    create: { connectionId, organizationId: ctx.organizationId, ...data },
    update: { ...data, rotatedAt: new Date() },
  });
}

export function decryptCredentials(
  ciphertext: string,
  organizationId: string,
  connectionId: string,
  keys: KeyRing,
): Record<string, string> {
  const plain = decryptSecret(
    deserializeSecret(ciphertext),
    credentialsAad(organizationId, connectionId),
    keys.ring,
  );
  return JSON.parse(plain.toString('utf8')) as Record<string, string>;
}
