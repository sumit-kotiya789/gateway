import { defineConfig } from 'vitest/config';

// MONEY-CRITICAL coverage gate: every file listed in docs/SECURITY.md "Money-critical files" goes here.
const MONEY_CRITICAL = ['packages/core/src/money.ts'];
const gate = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      thresholds: Object.fromEntries(MONEY_CRITICAL.map((f) => [f, gate])),
    },
  },
});
