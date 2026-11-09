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
  'apps/server/src/modules/xpubs/xpubs.routes.ts',
  'apps/server/src/modules/xpubs/xpubs.ts',
  'apps/server/src/modules/xpubs/ownership.ts',
  'packages/chains/src/evm/secrets.ts',
  'apps/server/src/modules/watcher/scanner.ts',
  'packages/core/src/fees.ts',
  'apps/server/src/modules/ledger/ledger.ts',
  'apps/server/src/modules/ledger/fee-balance.ts',
  'apps/server/src/modules/risk/risk.ts',
  // Custodial (M7)
  'apps/signer/src/signer.ts',
  'apps/signer/src/keys.ts',
  'apps/signer/src/seed.ts',
  'apps/server/src/modules/custody/treasury.ts',
  'apps/server/src/modules/custody/sweeper.ts',
  'apps/server/src/modules/custody/partials.ts',
  'apps/server/src/modules/custody/payouts.ts',
  'apps/server/src/modules/withdrawals/withdrawals.ts',
  // Forwarder mode (D-097)
  'packages/chains/src/evm/forwarder.ts',
  'apps/server/src/modules/custody/forwarder.ts',
  'apps/server/src/modules/custody/payout-addresses.ts',
  // Deposit accounts (D-101)
  'apps/server/src/modules/deposits/deposit-accounts.ts',
  // Hot wallet policy (D-105)
  'apps/server/src/modules/custody/hot-wallet-policy.ts',
  // Console settings incl. the two-admin withdrawal threshold (D-107)
  'apps/server/src/modules/admin/settings.ts',
  // Merchant whitelists (D-109)
  'apps/server/src/modules/security/whitelist.ts',
];
const gate = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          sequence: { groupOrder: 0 },
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
          sequence: { groupOrder: 0 },
        },
      },
      {
        // Tests that change platform-wide console settings (sign-ups, the admin IP allowlist, the two-admin threshold,
        // D-107): their own containers, one file at a time, after the parallel integration files, so they never
        // change the rules under another test.
        test: {
          name: 'integration-global',
          include: ['apps/server/test/global/**/*.test.ts'],
          globalSetup: ['apps/server/test/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 180_000,
          sequence: { groupOrder: 1 },
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
