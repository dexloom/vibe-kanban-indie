import path from 'path';
import { defineConfig } from 'vitest/config';

// Minimal Vitest config for @vibe/web-core's pure-logic unit tests
// (src/**/*.test.ts[x]). Mirrors the module aliases the local-web Vite
// config sets up for this package, so tests can use the same `@/*` and
// `shared/*` import paths as the app code.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${path.resolve(__dirname, 'src')}/`,
      },
      {
        find: 'shared',
        replacement: path.resolve(__dirname, '../../shared'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
