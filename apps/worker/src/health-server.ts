import { createServer, type Server, type ServerResponse } from 'node:http';
import { runChecks, type ReadinessCheck } from '@pcp/health';

export interface HealthServerOptions {
  service: string;
  deploymentMode: string;
  checks: ReadinessCheck[];
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createHealthServer({ service, deploymentMode, checks }: HealthServerOptions): Server {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return send(res, 200, { status: 'ok', service, deploymentMode });
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      const report = await runChecks(checks);
      return send(res, report.ok ? 200 : 503, {
        status: report.ok ? 'ready' : 'not_ready',
        checks: report.results,
      });
    }
    send(res, 404, { status: 'not_found' });
  });
}
