#!/usr/bin/env node
// pcp-db: database operations for deployment. Usage: pcp-db migrate
// Env: DATABASE_SUPERUSER_URL, PCP_MIGRATOR_PASSWORD, PCP_APP_PASSWORD, PCP_SCHEDULER_PASSWORD
import { migrate } from './migrate.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`pcp-db: ${name} must be set`);
    process.exit(2);
  }
  return value;
}

const command = process.argv[2];
if (command !== 'migrate') {
  console.error('usage: pcp-db migrate');
  process.exit(2);
}

await migrate({
  superuserUrl: required('DATABASE_SUPERUSER_URL'),
  passwords: {
    migrator: required('PCP_MIGRATOR_PASSWORD'),
    app: required('PCP_APP_PASSWORD'),
    scheduler: required('PCP_SCHEDULER_PASSWORD'),
  },
});
console.log('pcp-db: roles bootstrapped and migrations applied');
