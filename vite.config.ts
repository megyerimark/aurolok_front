import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts'] },
});
