import pg from 'pg';

export interface RolePasswords {
  migrator: string;
  app: string;
  scheduler: string;
}

/**
 * Creates or updates the database roles (ADR 0003, master plan D8). Runs as a
 * superuser before migrations. Idempotent.
 *
 * - pcp_migrator: owns tables; runs migrations.
 * - pcp_app: application runtime; NOBYPASSRLS; owns nothing.
 * - pcp_scheduler: EXECUTE on scheduler functions only (granted by later migrations).
 * - pcp_rls_definer: NOLOGIN BYPASSRLS; owns narrow SECURITY DEFINER lookups.
 */
export async function bootstrapRoles(superuserUrl: string, passwords: RolePasswords): Promise<void> {
  const client = new pg.Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    const database = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    const lit = (v: string) => client.escapeLiteral(v);
    const ident = (v: string) => client.escapeIdentifier(v);

    const roles: Array<[string, string]> = [
      [
        'pcp_migrator',
        `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${lit(passwords.migrator)}`,
      ],
      ['pcp_app', `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${lit(passwords.app)}`],
      [
        'pcp_scheduler',
        `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${lit(passwords.scheduler)}`,
      ],
      ['pcp_rls_definer', 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS'],
    ];
    for (const [role, options] of roles) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      await client.query(`${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} WITH ${options}`);
    }

    const statements = [
      `GRANT CONNECT ON DATABASE ${ident(database)} TO pcp_migrator, pcp_app, pcp_scheduler`,
      // Prisma migrate runs CREATE SCHEMA IF NOT EXISTS, which needs CREATE on the database.
      `GRANT CREATE ON DATABASE ${ident(database)} TO pcp_migrator`,
      'GRANT USAGE, CREATE ON SCHEMA public TO pcp_migrator, pcp_rls_definer',
      'GRANT USAGE ON SCHEMA public TO pcp_app, pcp_scheduler',
      // Lets migrations hand SECURITY DEFINER functions to pcp_rls_definer.
      'GRANT pcp_rls_definer TO pcp_migrator',
      'ALTER DEFAULT PRIVILEGES FOR ROLE pcp_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pcp_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE pcp_migrator IN SCHEMA public GRANT SELECT ON TABLES TO pcp_rls_definer',
      'ALTER DEFAULT PRIVILEGES FOR ROLE pcp_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pcp_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE pcp_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    ];
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
}
