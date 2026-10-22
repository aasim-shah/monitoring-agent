import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['agent-e2e/**/*.e2e.test.ts'],
    testTimeout: 900_000,
    // A cold build compiles the collector for amd64 and arm64 (~15 min with the M6b receivers).
    hookTimeout: 1_800_000,
    fileParallelism: false,
  },
});
