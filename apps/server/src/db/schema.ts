// Table definitions. DDL is generated from this file by drizzle-kit; roles, RLS, triggers and
// append-only rules live in hand-written SQL migrations (see db/migrations/*_security.sql).
import { uuidv7 } from '@gw/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().$defaultFn(uuidv7);
const createdAt = () => tstz('created_at').notNull().defaultNow();
/** Token minor units: NUMERIC(78,0), bigint in code. Never float. */
const money = (name: string) => numeric(name, { precision: 78, scale: 0, mode: 'bigint' });

export const custodyMode = pgEnum('custody_mode', ['custodial', 'non_custodial_xpub', 'non_custodial_forwarder']);
export const merchantStatus = pgEnum('merchant_status', ['active', 'suspended']);
// Admin-only markers (M5b). Informational until the features they gate exist: payouts_frozen blocks custodial payouts (M7).
export const merchantRiskFlag = pgEnum('merchant_risk_flag', ['under_review', 'high_risk', 'payouts_frozen']);
export const merchantRole = pgEnum('merchant_role', ['owner', 'admin', 'developer', 'finance', 'read_only']);
export const apiKeyKind = pgEnum('api_key_kind', ['secret', 'publishable']);
export const adminRole = pgEnum('admin_role', ['superadmin', 'operator', 'auditor']);
export const actorType = pgEnum('actor_type', ['merchant_user', 'admin', 'api_key', 'system', 'anonymous']);

export const merchants = pgTable(
  'merchants',
  {
    id: id(),
    name: text('name').notNull(),
    status: merchantStatus('status').notNull().default('active'),
    custodyMode: custodyMode('custody_mode').notNull().default('non_custodial_xpub'),
    feeBps: integer('fee_bps').notNull().default(100),
    underpayToleranceBps: integer('underpay_tolerance_bps').notNull().default(50),
    kyb: jsonb('kyb').notNull().default({}),
    riskFlags: merchantRiskFlag('risk_flags').array().notNull().default(sql`'{}'`),
    createdAt: createdAt(),
  },
  (t) => [
    check('merchants_name_len', sql`char_length(${t.name}) between 1 and 200`),
    check('merchants_fee_bps_range', sql`${t.feeBps} between 0 and 10000`),
    check('merchants_underpay_tolerance', sql`${t.underpayToleranceBps} between 0 and 500`),
  ],
);

export const merchantUsers = pgTable(
  'merchant_users',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: merchantRole('role').notNull(),
    totpSecretEnc: text('totp_secret_enc'),
    totpPendingEnc: text('totp_pending_enc'),
    totpEnabledAt: tstz('totp_enabled_at'),
    totpLastStep: bigint('totp_last_step', { mode: 'bigint' }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: tstz('locked_until'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('merchant_users_email_uq').on(sql`lower(${t.email})`),
    index('merchant_users_merchant_idx').on(t.merchantId),
    check('merchant_users_totp_enabled', sql`(${t.totpEnabledAt} is null) = (${t.totpSecretEnc} is null)`),
  ],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => merchantUsers.id),
    codeHash: text('code_hash').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('recovery_codes_user_code_uq').on(t.userId, t.codeHash)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => merchantUsers.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    mfa: boolean('mfa').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    familyExpiresAt: tstz('family_expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    replacedBy: uuid('replaced_by'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_family_idx').on(t.familyId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    kind: apiKeyKind('kind').notNull(),
    livemode: boolean('livemode').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    ipAllowlist: text('ip_allowlist').array(),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
    lastUsedAt: tstz('last_used_at'),
    createdBy: uuid('created_by').references(() => merchantUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_uq').on(t.prefix),
    index('api_keys_merchant_idx').on(t.merchantId),
    check('api_keys_name_len', sql`char_length(${t.name}) between 1 and 100`),
    check(
      'api_keys_publishable_scopes',
      sql`${t.kind} <> 'publishable' or ${t.scopes} = array['checkout']::text[]`,
    ),
  ],
);

export const adminUsers = pgTable(
  'admin_users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: adminRole('role').notNull(),
    totpSecretEnc: text('totp_secret_enc').notNull(),
    totpLastStep: bigint('totp_last_step', { mode: 'bigint' }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: tstz('locked_until'),
    disabledAt: tstz('disabled_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_users_email_uq').on(sql`lower(${t.email})`)],
);

// seq, at, prev_hash and hash are assigned by the audit_chain() trigger; values sent by the app are overwritten.
export const auditLogs = pgTable(
  'audit_logs',
  {
    seq: bigint('seq', { mode: 'bigint' }).primaryKey().default(sql`0`),
    id: uuid('id').notNull().$defaultFn(uuidv7),
    at: tstz('at').notNull().defaultNow(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    prevHash: bytea('prev_hash').notNull().default(sql`'\\x'::bytea`),
    hash: bytea('hash').notNull().default(sql`'\\x'::bytea`),
  },
  (t) => [uniqueIndex('audit_logs_id_uq').on(t.id), index('audit_logs_merchant_seq_idx').on(t.merchantId, t.seq)],
);

// ---------------------------------------------------------------- M2: registry + addresses

export const chainFamily = pgEnum('chain_family', ['evm', 'tron', 'solana']);
export const chainFinality = pgEnum('chain_finality', ['tag', 'confirmations']);
export const addressSource = pgEnum('address_source', ['platform', 'merchant_xpub']);
export const xpubStatus = pgEnum('xpub_status', ['active', 'retired']);

export const chains = pgTable(
  'chains',
  {
    id: text('id').primaryKey(),
    family: chainFamily('family').notNull(),
    name: text('name').notNull(),
    evmChainId: integer('evm_chain_id'),
    // May contain ${ENV_VAR} placeholders; provider keys never live in the DB.
    rpcUrls: text('rpc_urls').array().notNull(),
    explorerUrl: text('explorer_url'),
    nativeSymbol: text('native_symbol').notNull(),
    nativeDecimals: integer('native_decimals').notNull(),
    blockTimeMs: integer('block_time_ms').notNull(),
    defaultConfirmations: integer('default_confirmations').notNull(),
    reorgDepth: integer('reorg_depth').notNull(),
    finality: chainFinality('finality').notNull(),
    testnet: boolean('testnet').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check('chains_id_format', sql`${t.id} ~ '^[a-z0-9-]{2,32}$'`),
    check('chains_evm_chain_id', sql`${t.family} <> 'evm' or ${t.evmChainId} > 0`),
    check(
      'chains_numbers',
      sql`${t.nativeDecimals} between 0 and 77 and ${t.blockTimeMs} > 0 and ${t.defaultConfirmations} >= 1 and ${t.reorgDepth} >= 1`,
    ),
  ],
);

export const tokens = pgTable(
  'tokens',
  {
    id: text('id').primaryKey(),
    chainId: text('chain_id')
      .notNull()
      .references(() => chains.id),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    contractAddress: text('contract_address').notNull(),
    decimals: integer('decimals').notNull(),
    minConfirmations: integer('min_confirmations').notNull(),
    // [{ "min_amount": "<minor units>", "confirmations": n }]
    confirmationTiers: jsonb('confirmation_tiers').notNull().default([]),
    minAmount: money('min_amount').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tokens_chain_contract_uq').on(t.chainId, sql`lower(${t.contractAddress})`),
    uniqueIndex('tokens_chain_symbol_uq').on(t.chainId, t.symbol),
    check('tokens_id_format', sql`${t.id} ~ '^[a-z0-9-]{2,32}:[a-z0-9]{2,16}$'`),
    check('tokens_numbers', sql`${t.decimals} between 0 and 77 and ${t.minConfirmations} >= 1 and ${t.minAmount} >= 0`),
  ],
);

/** Platform HD accounts (custodial). xpub only; the seed never touches the app servers. */
export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: id(),
    family: chainFamily('family').notNull(),
    livemode: boolean('livemode').notNull(),
    basePath: text('base_path').notNull(), // e.g. m/44'/60'/0'
    xpub: text('xpub').notNull(),
    keyFingerprint: text('key_fingerprint').notNull(),
    nextIndex: bigint('next_index', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('wallet_accounts_family_mode_uq').on(t.family, t.livemode),
    uniqueIndex('wallet_accounts_fingerprint_uq').on(t.keyFingerprint),
    unique('wallet_accounts_fk_target').on(t.id, t.livemode, t.family),
    check('wallet_accounts_next_index', sql`${t.nextIndex} between 0 and 2147483648`),
  ],
);

/** Merchant-supplied account xpubs (non-custodial). Registration flow (2FA, ownership proof) is M8. */
export const merchantXpubs = pgTable(
  'merchant_xpubs',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    family: chainFamily('family').notNull(),
    livemode: boolean('livemode').notNull(),
    xpub: text('xpub').notNull(),
    // sha256(pubkey || chaincode): the same key in xpub and tpub encodings has one fingerprint.
    keyFingerprint: text('key_fingerprint').notNull(),
    nextIndex: bigint('next_index', { mode: 'number' }).notNull().default(0),
    status: xpubStatus('status').notNull().default('active'),
    retiredAt: tstz('retired_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('merchant_xpubs_fingerprint_uq').on(t.keyFingerprint),
    uniqueIndex('merchant_xpubs_one_active_uq').on(t.merchantId, t.family, t.livemode).where(sql`${t.status} = 'active'`),
    unique('merchant_xpubs_fk_target').on(t.id, t.merchantId, t.livemode, t.family),
    check('merchant_xpubs_next_index', sql`${t.nextIndex} between 0 and 2147483648`),
  ],
);

export const depositAddresses = pgTable(
  'deposit_addresses',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    family: chainFamily('family').notNull(),
    chainId: text('chain_id')
      .notNull()
      .references(() => chains.id),
    source: addressSource('source').notNull(),
    walletAccountId: uuid('wallet_account_id'),
    merchantXpubId: uuid('merchant_xpub_id'),
    derivationIndex: integer('derivation_index').notNull(),
    derivationPath: text('derivation_path').notNull(),
    address: text('address').notNull(),
    watchUntil: tstz('watch_until'),
    createdAt: createdAt(),
  },
  (t) => [
    // One address = one invoice across every chain of the family (shared key space, D-018).
    uniqueIndex('deposit_addresses_family_address_uq').on(t.family, sql`lower(${t.address})`),
    uniqueIndex('deposit_addresses_wallet_index_uq').on(t.walletAccountId, t.derivationIndex),
    uniqueIndex('deposit_addresses_xpub_index_uq').on(t.merchantXpubId, t.derivationIndex),
    index('deposit_addresses_merchant_idx').on(t.merchantId),
    check(
      'deposit_addresses_one_source',
      sql`(${t.source} = 'platform' and ${t.walletAccountId} is not null and ${t.merchantXpubId} is null)
       or (${t.source} = 'merchant_xpub' and ${t.merchantXpubId} is not null and ${t.walletAccountId} is null)`,
    ),
    check('deposit_addresses_index', sql`${t.derivationIndex} between 0 and 2147483647`),
    // Composite FKs: an address can only come from THIS merchant's xpub, in the same mode and family.
    foreignKey({
      name: 'deposit_addresses_merchant_xpub_fk',
      columns: [t.merchantXpubId, t.merchantId, t.livemode, t.family],
      foreignColumns: [merchantXpubs.id, merchantXpubs.merchantId, merchantXpubs.livemode, merchantXpubs.family],
    }),
    foreignKey({
      name: 'deposit_addresses_wallet_account_fk',
      columns: [t.walletAccountId, t.livemode, t.family],
      foreignColumns: [walletAccounts.id, walletAccounts.livemode, walletAccounts.family],
    }),
  ],
);

// ---------------------------------------------------------------- M3: invoices, payment links, idempotency

export const invoiceStatus = pgEnum('invoice_status', [
  'created',
  'pending',
  'detected',
  'confirming',
  'paid',
  'underpaid',
  'overpaid',
  'settled',
  'expired',
  'cancelled',
  'failed',
  'late_payment',
]);

export const paymentLinks = pgTable(
  'payment_links',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    amount: money('amount').notNull(),
    description: text('description'),
    metadata: jsonb('metadata').notNull().default({}),
    expiresInSeconds: integer('expires_in_seconds').notNull().default(1800),
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    // Bounds derivation-gap growth from abandoned visits (non-custodial wallets scan ~20 unused addresses ahead).
    maxPendingInvoices: integer('max_pending_invoices').notNull().default(20),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index('payment_links_merchant_idx').on(t.merchantId, t.livemode),
    check('payment_links_amount', sql`${t.amount} > 0`),
    check('payment_links_expiry', sql`${t.expiresInSeconds} between 300 and 86400`),
    check('payment_links_max_pending', sql`${t.maxPendingInvoices} between 1 and 1000`),
    check('payment_links_metadata_size', sql`octet_length(${t.metadata}::text) <= 4096`),
  ],
);

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    externalOrderId: text('external_order_id'),
    chainId: text('chain_id')
      .notNull()
      .references(() => chains.id),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    amountExpected: money('amount_expected').notNull(),
    amountReceived: money('amount_received').notNull().default(sql`0`),
    depositAddressId: uuid('deposit_address_id')
      .notNull()
      .references(() => depositAddresses.id),
    depositAddress: text('deposit_address').notNull(),
    custodyMode: custodyMode('custody_mode').notNull(),
    status: invoiceStatus('status').notNull().default('created'),
    underpayToleranceBps: integer('underpay_tolerance_bps').notNull(),
    // Snapshot of the merchant's fee at creation: a later fee change never affects existing invoices.
    feeBps: integer('fee_bps').notNull().default(100),
    description: text('description'),
    metadata: jsonb('metadata').notNull().default({}),
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    paymentLinkId: uuid('payment_link_id').references(() => paymentLinks.id),
    feeAmount: money('fee_amount'),
    expiresAt: tstz('expires_at').notNull(),
    statusChangedAt: tstz('status_changed_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invoices_deposit_address_uq').on(t.depositAddressId),
    uniqueIndex('invoices_external_order_uq')
      .on(t.merchantId, t.livemode, t.externalOrderId)
      .where(sql`${t.externalOrderId} is not null`),
    index('invoices_merchant_list_idx').on(t.merchantId, t.livemode, t.id),
    index('invoices_status_expiry_idx').on(t.status, t.expiresAt),
    index('invoices_payment_link_idx').on(t.paymentLinkId, t.status),
    check('invoices_amounts', sql`${t.amountExpected} > 0 and ${t.amountReceived} >= 0 and (${t.feeAmount} is null or ${t.feeAmount} >= 0)`),
    check('invoices_tolerance', sql`${t.underpayToleranceBps} between 0 and 500`),
    check('invoices_fee_bps', sql`${t.feeBps} between 0 and 10000`),
    check('invoices_metadata_size', sql`octet_length(${t.metadata}::text) <= 4096`),
    check('invoices_external_order_len', sql`${t.externalOrderId} is null or char_length(${t.externalOrderId}) between 1 and 200`),
  ],
);

/** Append-only status history: every transition, who/why. */
export const invoiceStatusHistory = pgTable(
  'invoice_status_history',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    fromStatus: invoiceStatus('from_status'),
    toStatus: invoiceStatus('to_status').notNull(),
    reason: text('reason').notNull(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('invoice_status_history_invoice_idx').on(t.invoiceId, t.id)],
);

// ---------------------------------------------------------------- M3b: webhook endpoints (delivery, signing, retries: M6)

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    // HMAC signing secret, envelope-encrypted (it must be recoverable to sign; never stored or logged in clear).
    secretEnc: text('secret_enc').notNull(),
    createdBy: uuid('created_by').references(() => merchantUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('webhook_endpoints_merchant_idx').on(t.merchantId, t.livemode),
    check('webhook_endpoints_url_len', sql`char_length(${t.url}) between 8 and 2000`),
    check('webhook_endpoints_description_len', sql`${t.description} is null or char_length(${t.description}) <= 200`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_uq').on(t.merchantId, t.livemode, t.key),
    index('idempotency_keys_created_idx').on(t.createdAt),
    check('idempotency_keys_key_len', sql`char_length(${t.key}) between 1 and 255`),
  ],
);

// ---------------------------------------------------------------- M4: watcher (payments, chain cursors)

export const paymentStatus = pgEnum('payment_status', ['detected', 'confirmed', 'orphaned']);

/** One on-chain token transfer to an invoice's deposit address. Identity is immutable; confirmed is final. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    chainId: text('chain_id')
      .notNull()
      .references(() => chains.id),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    amount: money('amount').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockHash: text('block_hash').notNull(),
    blockTime: tstz('block_time').notNull(),
    requiredConfirmations: integer('required_confirmations').notNull(),
    status: paymentStatus('status').notNull().default('detected'),
    confirmedAt: tstz('confirmed_at'),
    orphanedAt: tstz('orphaned_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payments_chain_tx_log_uq').on(t.chainId, t.txHash, t.logIndex),
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_chain_status_idx').on(t.chainId, t.status),
    check('payments_amount', sql`${t.amount} > 0`),
    check('payments_numbers', sql`${t.logIndex} >= 0 and ${t.blockNumber} >= 0 and ${t.requiredConfirmations} >= 1`),
  ],
);

/** Scanner progress per chain. Writes are fenced by leader_epoch (D-017). */
export const chainCursors = pgTable('chain_cursors', {
  chainId: text('chain_id')
    .primaryKey()
    .references(() => chains.id),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockHash: text('block_hash').notNull(),
  // Timestamp of the cursor block: invoices expire only once the scanner has passed their deadline.
  blockTime: tstz('block_time').notNull(),
  leaderEpoch: bigint('leader_epoch', { mode: 'number' }).notNull().default(0),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------- M5: ledger, outbox, reconciliation

export const ledgerAccountKind = pgEnum('ledger_account_kind', [
  // Non-custodial memo pair: funds received into the merchant's own wallet (asset) / the merchant's sales (income).
  'merchant_received',
  'merchant_sales',
  // What the merchant owes the platform in fees (asset of the platform; prepaid top-ups credit it, M8).
  'merchant_fees_owed',
  // Platform income from fees. merchant_id is null.
  'platform_fee_revenue',
]);
export const ledgerJournalKind = pgEnum('ledger_journal_kind', ['payment', 'fee']);

/** One account per (kind, merchant, mode, token). Platform accounts have merchant_id null. */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    kind: ledgerAccountKind('kind').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ledger_accounts_uq').on(t.kind, t.merchantId, t.livemode, t.tokenId).nullsNotDistinct(),
    check('ledger_accounts_owner', sql`(${t.kind} = 'platform_fee_revenue') = (${t.merchantId} is null)`),
  ],
);

/** A balanced set of entries (sum = 0, one token). Append-only. One payment journal per payment, one fee journal per invoice. */
export const ledgerJournals = pgTable(
  'ledger_journals',
  {
    id: id(),
    kind: ledgerJournalKind('kind').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    paymentId: uuid('payment_id').references(() => payments.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_journals_payment_uq').on(t.paymentId).where(sql`${t.kind} = 'payment'`),
    uniqueIndex('ledger_journals_fee_uq').on(t.invoiceId).where(sql`${t.kind} = 'fee'`),
    index('ledger_journals_merchant_idx').on(t.merchantId, t.livemode),
    check('ledger_journals_payment_ref', sql`(${t.kind} = 'payment') = (${t.paymentId} is not null)`),
  ],
);

/** Signed minor units: debit > 0, credit < 0. merchant_id copies the account's owner (RLS). */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => ledgerJournals.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_journal_idx').on(t.journalId),
    index('ledger_entries_account_idx').on(t.accountId),
    check('ledger_entries_nonzero', sql`${t.amount} <> 0`),
  ],
);

/** Written only by the invoices trigger, in the transaction that changed the status. Delivery (webhooks) is M6. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    seq: bigint('seq', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid('id').notNull().default(sql`gen_random_uuid()`),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    livemode: boolean('livemode').notNull(),
    type: text('type').notNull(),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('outbox_events_id_uq').on(t.id), index('outbox_events_merchant_idx').on(t.merchantId, t.livemode, t.seq)],
);

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: id(),
  startedAt: tstz('started_at').notNull(),
  finishedAt: tstz('finished_at').notNull(),
  ok: boolean('ok').notNull(),
  issues: jsonb('issues').notNull(),
});
