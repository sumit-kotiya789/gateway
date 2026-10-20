import { defineConfig } from 'vitest/config';

// MONEY-CRITICAL coverage gate: every file listed in docs/SECURITY.md "Money-critical files" goes here.
const MONEY_CRITICAL = ['packages/core/src/money.ts'];
const gate = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
        },
      },
      {
        // Needs Docker: Postgres + Redis via Testcontainers, started once per run.
        test: {
          name: 'integration',
          include: ['apps/*/test/integration/**/*.test.ts'],
          globalSetup: ['apps/server/test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['apps/*/src/cli/**', 'apps/*/src/main-*.ts'],
      thresholds: Object.fromEntries(MONEY_CRITICAL.map((f) => [f, gate])),
    },
  },
});
