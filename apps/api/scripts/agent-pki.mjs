#!/usr/bin/env node
// Generates a development/self-hosted agent PKI (master plan D11).
// Usage: pnpm --filter @pcp/api agent:pki --out <dir>
// Writes root.pem, root.key (keep offline), intermediate.pem, chain.pem (for Caddy),
// and prints the AGENT_CA_* and TASK_SIGNING_KEY lines for .env.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateDevPki } from '../dist/modules/agents/ca/pki.js';

const i = process.argv.indexOf('--out');
if (i < 0 || !process.argv[i + 1]) {
  console.error('usage: agent-pki --out <dir>');
  process.exit(2);
}
const out = resolve(process.argv[i + 1]);
mkdirSync(out, { recursive: true });
const pki = await generateDevPki();
writeFileSync(join(out, 'root.pem'), pki.rootCertPem);
writeFileSync(join(out, 'root.key'), pki.rootKeyPem, { mode: 0o600 });
chmodSync(join(out, 'root.key'), 0o600);
writeFileSync(join(out, 'intermediate.pem'), pki.intermediateCertPem);
writeFileSync(join(out, 'chain.pem'), pki.chainPem);
const b64 = (s) => Buffer.from(s).toString('base64');
console.error(`Wrote ${out}. Keep root.key offline; set AGENT_CA_DIR=${out} for Caddy.`);
console.log(`AGENT_CA_CERT=${b64(pki.intermediateCertPem)}`);
console.log(`AGENT_CA_KEY=${b64(pki.intermediateKeyPem)}`);
console.log(`AGENT_CA_CHAIN=${b64(pki.chainPem)}`);
console.log(`TASK_SIGNING_KEY=${b64(pki.taskSigningKeyPem)}`);
