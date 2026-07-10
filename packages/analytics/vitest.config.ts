import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'analytics',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // This suite asserted Claude-only hook events and project-state side effects.
    // Codex hook contracts are tested with the plugin hooks, not the analytics
    // runtime, which now reads CODEX_HOME rollouts without hook dependencies.
    exclude: ['src/__tests__/hooks-smoke.test.ts'],
    testTimeout: 30000,
  },
});
