// Table definitions. DDL is generated from this file by drizzle-kit; roles, RLS, triggers and
// append-only rules live in hand-written SQL migrations (see db/migrations/*_security.sql).
import { uuidv7 } from '@gw/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().$defaultFn(uuidv7);
const createdAt = () => tstz('created_at').notNull().defaultNow();

export const custodyMode = pgEnum('custody_mode', ['custodial', 'non_custodial_xpub', 'non_custodial_forwarder']);
export const merchantStatus = pgEnum('merchant_status', ['active', 'suspended']);
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
    kyb: jsonb('kyb').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check('merchants_name_len', sql`char_length(${t.name}) between 1 and 200`),
    check('merchants_fee_bps_range', sql`${t.feeBps} between 0 and 10000`),
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
