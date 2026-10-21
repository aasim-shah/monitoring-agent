import { RedisContainer } from '@testcontainers/redis';

export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  const container = await new RedisContainer('redis:7.4.6-alpine').start();
  return {
    url: container.getConnectionUrl(),
    async stop() {
      await container.stop();
    },
  };
}
