import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['agent-e2e/**/*.e2e.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
