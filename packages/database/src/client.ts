import { PrismaClient } from '../generated/client/index.js';

export function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url });
}
