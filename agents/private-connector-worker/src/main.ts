#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectorRegistry } from '@pcp/connector-sdk';
import { customHttpConnector } from '@pcp/connectors-custom-http';
import { mongodbConnector, mysqlConnector, postgresConnector } from '@pcp/connectors-databases';
import { VERSION, enroll, newKeyAndCsr } from './enroll.js';
import { dispatcher, request, type TlsIdentity } from './http.js';
import { capResult } from './limits.js';
import { runOp, type ConnectorOp } from './ops.js';
import { SECRETS_DIR, loadSecret } from './secrets.js';
import { loadState, saveState, type WorkerState } from './state.js';
import { verifyTask } from './verify.js';

const env = process.env;
const stateDir = env.PCP_STATE_DIR ?? '/var/lib/pcp-worker';
const secretsDir = env.PCP_SECRETS_DIR ?? SECRETS_DIR;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const registry = new ConnectorRegistry();
for (const c of [postgresConnector, mysqlConnector, mongodbConnector, customHttpConnector])
  registry.register(c);

async function identity(): Promise<TlsIdentity> {
  return {
    certPem: await readFile(join(stateDir, 'worker.crt'), 'utf8'),
    keyPem: await readFile(join(stateDir, 'worker.key'), 'utf8'),
  };
}

/** Renews the certificate 10 days before expiry (day 20 of 30), like the host agent. */
async function rotateIfDue(state: WorkerState, id: TlsIdentity): Promise<TlsIdentity | undefined> {
  if (Date.parse(state.notAfter) - Date.now() > 10 * 86400_000) return undefined;
  const { keyPem, csrPem } = await newKeyAndCsr();
  const res = await request(state.controlUrl, 'POST', '/agent/v1/rotate', {
    caFile: state.caFile,
    identity: id,
    body: { csrPem },
  });
  if (res.status !== 200) throw new Error(`rotation failed: ${res.status}`);
  const body = res.json as { certificatePem: string; chainPem: string; notAfter: string };
  await writeFile(join(stateDir, 'worker.key'), keyPem, { mode: 0o600 });
  await writeFile(join(stateDir, 'worker.crt'), body.certificatePem, { mode: 0o600 });
  await writeFile(join(stateDir, 'chain.pem'), body.chainPem, { mode: 0o600 });
  state.notAfter = body.notAfter;
  await saveState(stateDir, state);
  log(`certificate rotated; valid until ${body.notAfter}`);
  return { certPem: body.certificatePem, keyPem };
}

async function run(): Promise<never> {
  const state = await loadState(stateDir);
  if (!state) throw new Error(`not enrolled (no ${stateDir}/state.json); run enroll first`);
  let id = await identity();
  let agent = dispatcher({ caFile: state.caFile, identity: id });
  const call = (method: string, path: string, body?: unknown) =>
    request(state.controlUrl, method, path, { agent, body });

  const beat = async () => {
    const res = await call('POST', '/agent/v1/heartbeat', {
      protocolVersion: '1.0',
      sequence: Date.now(),
      agentVersion: VERSION,
      policyVersion: 1,
      capabilities: ['connector_op'],
      health: 'ok',
      queueDepth: 0,
      sentAt: new Date().toISOString(),
    }).catch((e: Error) => ({ status: 0, json: e.message }));
    if (res.status !== 202) log(`heartbeat: ${res.status} ${JSON.stringify(res.json)}`);
  };
  await beat();
  setInterval(() => void beat(), 30_000).unref();
  log(`private worker ${state.agentId} running; secrets from ${secretsDir}`);

  for (;;) {
    try {
      const rotated = await rotateIfDue(state, id);
      if (rotated) {
        id = rotated;
        await agent.close();
        agent = dispatcher({ caFile: state.caFile, identity: id });
      }
    } catch (e) {
      log(`rotation: ${(e as Error).message}`);
    }
    let res;
    try {
      res = await call('GET', '/agent/v1/tasks?wait=25');
    } catch (e) {
      log(`poll: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (res.status === 401)
      throw new Error('the control plane rejected this worker (revoked or certificate expired); re-enroll');
    if (res.status !== 200) {
      log(`poll: ${res.status}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const task of (res.json as { tasks?: Array<Record<string, unknown>> }).tasks ?? []) {
      const verdict = verifyTask(task, state.taskSigningPublicKey);
      if (!verdict.ok) {
        log(`dropped task ${String(task.id)}: ${verdict.reason}`);
        continue;
      }
      const outcome =
        task.type === 'connector_op'
          ? await runOp(
              task.payload as unknown as ConnectorOp,
              { registry, loadSecret: (ref) => loadSecret(ref, secretsDir) },
              Number(task.maxRuntimeSeconds ?? 60) * 1000,
            )
          : {
              status: 'failed' as const,
              error: `task type ${String(task.type)} is not supported by the private worker`,
            };
      const body = capResult(outcome);
      const posted = await call('POST', `/agent/v1/tasks/${String(task.id)}/result`, body).catch(
        (e: Error) => ({ status: 0, json: e.message }),
      );
      const op = (task.payload as { operation?: string; provider?: string } | undefined) ?? {};
      log(
        `task ${String(task.id)} ${op.provider ?? ''} ${op.operation ?? task.type} → ${outcome.status} (posted ${posted.status})`,
      );
    }
  }
}

async function main() {
  const cmd = process.argv[2];
  const token = flag('token') ?? env.PCP_TOKEN;
  const controlUrl = flag('control-url') ?? env.PCP_CONTROL_URL;
  const caFile = flag('ca-file') ?? env.PCP_CA_FILE;
  if (cmd === 'enroll' || cmd === 'enroll-and-run') {
    const existing = await loadState(stateDir);
    if (existing && cmd === 'enroll-and-run') log(`already enrolled as ${existing.agentId}`);
    else {
      if (!token || !controlUrl) throw new Error('--token and --control-url are required');
      const s = await enroll({ token, controlUrl, stateDir, caFile });
      log(`enrolled as private worker ${s.agentId}; certificate valid until ${s.notAfter}`);
    }
    if (cmd === 'enroll') return;
    await run();
  } else if (cmd === 'run') {
    await run();
  } else {
    console.error(
      'usage: pcp-private-worker enroll|run|enroll-and-run --token TOKEN --control-url URL [--ca-file FILE]',
    );
    process.exit(2);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
