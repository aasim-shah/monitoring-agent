export { PrismaClient, Prisma } from '../generated/client/index.js';
export type * from '../generated/client/index.js';
export { createPrismaClient } from './client.js';
export { TENANT_TABLES, type TenantTable } from './tables.js';
export { bootstrapRoles, type RolePasswords } from './bootstrap.js';
export { migrate, prismaCli, type MigrateOptions, type CliResult } from './migrate.js';
export { withCredentials } from './urls.js';
