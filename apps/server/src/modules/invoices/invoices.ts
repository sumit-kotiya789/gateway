// MONEY-CRITICAL
// Invoice creation, status transitions and expiry. Amounts are bigint minor units; decimal strings exist only in views.
import {
  AppError,
  canTransition,
  fromMinorUnits,
  toMinorUnits,
  type InvoiceStatus,
} from '@gw/core';
import { and, eq, lte, sql } from 'drizzle-orm';
import { audit } from '../../common/audit.js';
import { withSystem, type Tx } from '../../common/db.js';
import { chainCursors, chains, depositAddresses, invoices, merchants, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { allocateDepositAddress } from '../custody/custody.js';
import { rowToChain } from '../registry/registry.js';

export const EXPIRY_S = { min: 300, max: 86_400, default: 1800 } as const;
/** Deposit addresses stay watched this long after expiry so late payments are recorded (D-043). */
export const LATE_PAYMENT_WATCH_MS = 30 * 24 * 3600_000;

export type InvoiceRow = typeof invoices.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;
type ChainRow = typeof chains.$inferSelect;

export interface CreateInvoiceInput {
  amount: string;
  token: string;
  externalOrderId?: string | undefined;
  description?: string | undefined;
  metadata?: Record<string, string> | undefined;
  expiresInSeconds?: number | undefined;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
  paymentLinkId?: string | undefined;
}

/** Token + chain usable for this mode: both enabled, testnet for test mode, mainnet for live mode. */
export async function resolveToken(tx: Tx, tokenId: string, livemode: boolean): Promise<{ token: TokenRow; chain: ChainRow }> {
  const [r] = await tx.select({ token: tokens, chain: chains }).from(tokens).innerJoin(chains, eq(chains.id, tokens.chainId)).where(eq(tokens.id, tokenId));
  if (!r || !r.token.enabled || !r.chain.enabled || r.chain.testnet === livemode) {
    throw new AppError('validation_error', `token ${tokenId} is not available in ${livemode ? 'live' : 'test'} mode`, { field: 'token' });
  }
  return r;
}

/** Parses an amount for a token: exact decimals, positive, at or above the token's dust threshold. */
export function parseInvoiceAmount(amount: string, token: Pick<TokenRow, 'decimals' | 'minAmount' | 'symbol'>): bigint {
  const minor = toMinorUnits(amount, token.decimals);
  if (minor <= 0n) throw new AppError('invalid_amount', 'amount must be greater than zero');
  if (minor < token.minAmount) {
    throw new AppError('invalid_amount', `amount is below the minimum of ${fromMinorUnits(token.minAmount, token.decimals)} ${token.symbol}`);
  }
  return minor;
}

async function setReason(tx: Tx, reason: string): Promise<void> {
  await tx.execute(sql`select set_config('app.transition_reason', ${reason.slice(0, 200)}, true)`);
}

export async function createInvoice(deps: Deps, tx: Tx, merchantId: string, livemode: boolean, input: CreateInvoiceInput): Promise<InvoiceRow> {
  const { token, chain } = await resolveToken(tx, input.token, livemode);
  const amountExpected = parseInvoiceAmount(input.amount, token);
  const expiresIn = input.expiresInSeconds ?? EXPIRY_S.default;
  if (!Number.isInteger(expiresIn) || expiresIn < EXPIRY_S.min || expiresIn > EXPIRY_S.max) {
    throw new AppError('validation_error', `expires_in must be between ${EXPIRY_S.min} and ${EXPIRY_S.max} seconds`);
  }
  const [m] = await tx.select({ tolerance: merchants.underpayToleranceBps }).from(merchants).where(eq(merchants.id, merchantId));
  if (!m) throw new AppError('not_found', 'merchant not found');

  const addr = await allocateDepositAddress(tx, { merchantId, livemode, chain: rowToChain(chain) }, { custodialEnabled: deps.config.FEATURE_CUSTODIAL });
  const expiresAt = new Date(deps.clock() + expiresIn * 1000);
  await tx.update(depositAddresses).set({ watchUntil: new Date(expiresAt.getTime() + LATE_PAYMENT_WATCH_MS) }).where(eq(depositAddresses.id, addr.id));

  await setReason(tx, 'invoice created');
  const [inv] = await tx
    .insert(invoices)
    .values({
      merchantId,
      livemode,
      externalOrderId: input.externalOrderId ?? null,
      chainId: chain.id,
      tokenId: token.id,
      amountExpected,
      depositAddressId: addr.id,
      depositAddress: addr.address,
      custodyMode: addr.custodyMode,
      underpayToleranceBps: m.tolerance,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      paymentLinkId: input.paymentLinkId ?? null,
      expiresAt,
    })
    .returning();
  if (!inv) throw new Error('invoice insert failed');
  return transitionInvoice(deps, tx, inv.id, 'pending', 'deposit address allocated');
}

/**
 * The only way an invoice changes status in application code. Locks the row, validates the transition against the
 * core table (the DB trigger re-validates), records the reason. Illegal attempts are raised as 409 and audited on a
 * separate connection WITHOUT awaiting: the caller's transaction may hold the audit-chain lock and is about to roll
 * back; awaiting here would deadlock.
 */
export async function transitionInvoice(deps: Deps, tx: Tx, invoiceId: string, to: InvoiceStatus, reason: string): Promise<InvoiceRow> {
  const [cur] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!cur) throw new AppError('not_found', 'invoice not found');
  if (!canTransition(cur.status, to)) {
    void withSystem(deps.db, (stx) =>
      audit(stx, {
        actorType: 'system',
        merchantId: cur.merchantId,
        action: 'invoice.illegal_transition',
        targetType: 'invoice',
        targetId: cur.id,
        before: { status: cur.status },
        after: { attempted: to, reason },
      }),
    ).catch((e: unknown) => {
      deps.log.error({ err: e, invoiceId: cur.id }, 'failed to audit illegal invoice transition');
    });
    throw new AppError('conflict', `invoice cannot move from ${cur.status} to ${to}`, { from: cur.status, to });
  }
  await setReason(tx, reason);
  const [next] = await tx.update(invoices).set({ status: to }).where(eq(invoices.id, invoiceId)).returning();
  if (!next) throw new Error('invoice update failed');
  return next;
}

/**
 * Expires pending invoices past their deadline. Safe to run concurrently (SKIP LOCKED). Returns ids expired.
 * Only once the chain's scanner has passed the deadline (cursor block time >= expires_at): a payment mined in time
 * is always recorded first, so a lagging or stopped watcher can never expire an invoice that was paid on time.
 */
export async function expireDueInvoices(deps: Deps, batch = 500): Promise<string[]> {
  return withSystem(deps.db, async (tx) => {
    await setReason(tx, 'expired: no payment before deadline');
    const now = new Date(deps.clock());
    const due = tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.status, 'pending'),
          lte(invoices.expiresAt, now),
          sql`exists (select 1 from ${chainCursors} where ${chainCursors.chainId} = ${invoices.chainId} and ${chainCursors.blockTime} >= ${invoices.expiresAt})`,
        ),
      )
      .orderBy(invoices.expiresAt)
      .limit(batch)
      .for('update', { skipLocked: true });
    const rows = await tx
      .update(invoices)
      .set({ status: 'expired' })
      .where(sql`${invoices.id} in (${due})`)
      .returning({ id: invoices.id });
    return rows.map((r) => r.id);
  });
}

/** EIP-681 token transfer URI: wallets pre-fill token, recipient, amount and chain. */
export function paymentUri(token: Pick<TokenRow, 'contractAddress'>, chain: Pick<ChainRow, 'evmChainId' | 'family'>, to: string, amount: bigint): string | null {
  if (chain.family !== 'evm' || chain.evmChainId === null) return null;
  return `ethereum:${token.contractAddress}@${String(chain.evmChainId)}/transfer?address=${to}&uint256=${amount.toString()}`;
}

export function invoiceView(inv: InvoiceRow, token: TokenRow, chain: ChainRow, baseUrl: string) {
  return {
    id: inv.id,
    object: 'invoice' as const,
    status: inv.status,
    livemode: inv.livemode,
    custody_mode: inv.custodyMode,
    amount: fromMinorUnits(inv.amountExpected, token.decimals),
    amount_received: fromMinorUnits(inv.amountReceived, token.decimals),
    token: token.id,
    symbol: token.symbol,
    chain: chain.id,
    network: chain.name,
    deposit_address: inv.depositAddress,
    payment_uri: paymentUri(token, chain, inv.depositAddress, inv.amountExpected),
    checkout_url: `${baseUrl}/checkout/${inv.id}`,
    external_order_id: inv.externalOrderId,
    description: inv.description,
    metadata: inv.metadata,
    success_url: inv.successUrl,
    cancel_url: inv.cancelUrl,
    payment_link_id: inv.paymentLinkId,
    expires_at: inv.expiresAt.toISOString(),
    status_changed_at: inv.statusChangedAt.toISOString(),
    created_at: inv.createdAt.toISOString(),
  };
}

export async function loadInvoiceWithToken(tx: Tx, where: ReturnType<typeof eq>) {
  const [r] = await tx
    .select({ inv: invoices, token: tokens, chain: chains })
    .from(invoices)
    .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
    .innerJoin(chains, eq(chains.id, invoices.chainId))
    .where(where);
  return r;
}
