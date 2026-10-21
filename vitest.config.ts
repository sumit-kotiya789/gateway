import { defineConfig } from 'vitest/config';

// MONEY-CRITICAL coverage gate: every file listed in docs/SECURITY.md "Money-critical files" goes here.
const MONEY_CRITICAL = [
  'packages/core/src/money.ts',
  'packages/core/src/confirmations.ts',
  'packages/core/src/invoice.ts',
  'packages/chains/src/evm/deriver.ts',
  'packages/chains/src/evm/transfers.ts',
  'apps/server/src/modules/custody/custody.ts',
  'apps/server/src/db/seed-registry.ts',
  'apps/server/src/modules/invoices/invoices.ts',
];
const gate = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/*/test/integration/**'],
        },
      },
      {
        // Needs Docker: Postgres, Redis and Anvil via Testcontainers, started once per run.
        test: {
          name: 'integration',
          include: ['apps/*/test/integration/**/*.test.ts', 'packages/*/test/integration/**/*.test.ts'],
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
