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
  // Serialize submissions for this connection: Prisma's upsert reads then writes, and
  // ON CONFLICT alone does not cover the second unique index, so concurrent inserts could
  // still fail. The row lock lasts until the caller's transaction ends.
  await tx.$executeRaw`SELECT 1 FROM connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
  await tx.$executeRaw`
    INSERT INTO connection_secrets (connection_id, organization_id, ciphertext, key_version)
    VALUES (${connectionId}::uuid, ${ctx.organizationId}::uuid, ${serializeSecret(sealed)}, ${sealed.keyVersion})
    ON CONFLICT (connection_id) DO UPDATE
      SET ciphertext = EXCLUDED.ciphertext, key_version = EXCLUDED.key_version, rotated_at = now()`;
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
