import { redisCheck } from '@pcp/health';
import { loadConfig } from './config.js';
import { createHealthServer } from './health-server.js';

const config = loadConfig(process.env);
const server = createHealthServer({
  service: 'worker',
  deploymentMode: config.deploymentMode,
  checks: [redisCheck(config.redisUrl)],
});
server.listen(config.healthPort, '0.0.0.0');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
