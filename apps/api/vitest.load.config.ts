import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Load baselines (M19.2): not part of `pnpm test`. Run: pnpm --filter @pcp/api load
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['load/**/*.load.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
});
