import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    include: ['{app,components,lib}/**/*.test.{ts,tsx}', 'middleware.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
