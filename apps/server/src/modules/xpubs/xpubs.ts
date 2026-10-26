// MONEY-CRITICAL
// Merchant xpub lifecycle (non-custodial). Every future deposit address of a mode derives from the active xpub: a wrong
// key sends customer funds to addresses the merchant cannot spend. Safeguards (D-050, D-075): secret material refused
// and recorded, preview of the first addresses, owner-only + fresh TOTP, ownership proof for live keys, a cooldown
// before a live key replaces another, every step audited.
import { AppError, fromMinorUnits } from '@gw/core';
import { detectSecretMaterial, evmDeriver } from '@gw/chains';
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { audit } from '../../common/audit.js';
import { withSystem, withTenant, type Tx } from '../../common/db.js';
import { depositAddresses, invoices, merchants, merchantXpubs, tokens, xpubChanges } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { verifyOwnership } from './ownership.js';

/** A live key replacing another waits this long (D-075). Test keys switch at once. */
export const XPUB_CHANGE_COOLDOWN_MS = 24 * 3600_000;
/** Most wallets stop scanning after 20 unused addresses; we never recommend less. */
export const MIN_WALLET_GAP_LIMIT = 20;

type XpubRow = typeof merchantXpubs.$inferSelect;
type ChangeRow = typeof xpubChanges.$inferSelect;
interface Actor {
  id: string;
  merchantId: string;
}

const hint = (xpub: string) => `${xpub.slice(0, 8)}…${xpub.slice(-6)}`;

/** The full xpub is never returned: it reveals every address (privacy). Fingerprint + first address identify it. */
export function xpubView(x: XpubRow) {
  return {
    id: x.id,
    family: x.family,
    livemode: x.livemode,
    status: x.status,
    xpub_hint: hint(x.xpub),
    fingerprint: x.keyFingerprint.slice(0, 16),
    first_address: evmDeriver.deriveFromXpub(x.xpub, 0).address,
    next_index: x.nextIndex,
    ownership_proved_at: x.ownershipProvedAt?.toISOString() ?? null,
    retired_at: x.retiredAt?.toISOString() ?? null,
    created_at: x.createdAt.toISOString(),
  };
}

export function changeView(c: ChangeRow) {
  return {
    id: c.id,
    family: c.family,
    livemode: c.livemode,
    status: c.status,
    xpub_hint: hint(c.xpub),
    fingerprint: c.keyFingerprint.slice(0, 16),
    first_address: evmDeriver.deriveFromXpub(c.xpub, 0).address,
    activates_at: c.activatesAt.toISOString(),
    resolved_at: c.resolvedAt?.toISOString() ?? null,
    resolved_note: c.resolvedNote,
    created_at: c.createdAt.toISOString(),
  };
}

/**
 * Refuses secret key material pasted where an xpub belongs. The attempt is recorded as a security event (kind only,
 * never the value) in its own transaction, so it survives the failed request.
 */
export async function rejectSecretMaterial(deps: Deps, actor: Actor, input: string, req: FastifyRequest): Promise<void> {
  const kind = detectSecretMaterial(input);
  if (!kind) return;
  await withTenant(deps.db, actor.merchantId, (tx) =>
    audit(tx, { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'security.secret_submitted', after: { kind, field: 'xpub' } }, req),
  );
  deps.log.warn({ merchantId: actor.merchantId, kind }, 'secret key material submitted as xpub');
  throw new AppError(
    'validation_error',
    'this looks like a seed phrase or private key, not an xpub. It was not stored, but treat it as exposed: move its funds to a new wallet.',
    { reason: 'secret_material', kind },
  );
}

const activeOf = (merchantId: string, livemode: boolean) =>
  and(eq(merchantXpubs.merchantId, merchantId), eq(merchantXpubs.family, 'evm'), eq(merchantXpubs.livemode, livemode), eq(merchantXpubs.status, 'active'));

const pendingOf = (merchantId: string, livemode: boolean) =>
  and(eq(xpubChanges.merchantId, merchantId), eq(xpubChanges.family, 'evm'), eq(xpubChanges.livemode, livemode), eq(xpubChanges.status, 'pending'));

const brief = (x: XpubRow) => ({ id: x.id, fingerprint: x.keyFingerprint.slice(0, 16), next_index: x.nextIndex });

export async function pendingChange(tx: Tx, merchantId: string, livemode: boolean): Promise<ChangeRow | undefined> {
  const [c] = await tx.select().from(xpubChanges).where(pendingOf(merchantId, livemode));
  return c;
}

export interface RegisterInput {
  livemode: boolean;
  xpub: string;
  ownership?: { issuedAt: string; signature: string } | undefined;
}

export type RegisterResult = { kind: 'active'; xpub: XpubRow } | { kind: 'pending'; change: ChangeRow };

/**
 * Registers an xpub. Without an active key of that mode, or in test mode, it becomes active at once (retiring the
 * previous one). A live key replacing an active one becomes a pending change that the worker applies after the
 * cooldown, while the current key keeps serving invoices.
 */
export async function registerXpub(deps: Deps, tx: Tx, actor: Actor, input: RegisterInput, req: FastifyRequest): Promise<RegisterResult> {
  const { livemode, xpub } = input;
  const fingerprint = evmDeriver.keyFingerprint(xpub); // validates; refuses private keys
  const firstAddress = evmDeriver.deriveFromXpub(xpub, 0).address;
  const now = deps.clock();
  let provedAt: Date | null = null;
  if (input.ownership) {
    const challenge = { merchantId: actor.merchantId, livemode, fingerprint: fingerprint.slice(0, 16), address: firstAddress, issuedAt: input.ownership.issuedAt };
    await verifyOwnership(challenge, input.ownership.signature, now);
    provedAt = new Date(now);
  } else if (livemode) {
    throw new AppError('validation_error', 'live xpubs need an ownership proof: sign the challenge with the wallet', { reason: 'proof_required' });
  }

  const [m] = await tx.select({ mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, actor.merchantId));
  if (m?.mode !== 'non_custodial_xpub') throw new AppError('conflict', 'xpubs are only used in non-custodial xpub mode');
  const [prev] = await tx.select().from(merchantXpubs).where(activeOf(actor.merchantId, livemode)).for('update');
  if (prev?.keyFingerprint === fingerprint) throw new AppError('conflict', 'this xpub is already active');
  if (await pendingChange(tx, actor.merchantId, livemode)) throw new AppError('conflict', 'an xpub change is already pending; cancel it first');
  const after = { livemode, fingerprint: fingerprint.slice(0, 16), first_address: firstAddress, ownership_proved: provedAt !== null };

  if (prev && livemode && provedAt) {
    const [c] = await tx
      .insert(xpubChanges)
      .values({
        merchantId: actor.merchantId,
        family: 'evm',
        livemode,
        xpub,
        keyFingerprint: fingerprint,
        requestedBy: actor.id,
        ownershipProvedAt: provedAt,
        activatesAt: new Date(now + XPUB_CHANGE_COOLDOWN_MS),
      })
      .returning();
    /* v8 ignore next -- invariant: INSERT ... RETURNING yields the row or throws */
    if (!c) throw new Error('xpub change insert failed');
    await audit(
      tx,
      { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'xpub.change_requested', targetType: 'xpub_change', targetId: c.id, before: brief(prev), after: { ...after, activates_at: c.activatesAt.toISOString() } },
      req,
    );
    deps.log.warn({ merchantId: actor.merchantId, changeId: c.id }, 'live xpub change requested; applies after cooldown');
    return { kind: 'pending', change: c };
  }

  if (prev) await tx.update(merchantXpubs).set({ status: 'retired', retiredAt: new Date(now) }).where(eq(merchantXpubs.id, prev.id));
  // Unique fingerprint across all merchants, platform wallets and pending changes (D-038): a reused key fails as 409.
  const [x] = await tx
    .insert(merchantXpubs)
    .values({ merchantId: actor.merchantId, family: 'evm', livemode, xpub, keyFingerprint: fingerprint, ownershipProvedAt: provedAt })
    .returning();
  /* v8 ignore next -- invariant: INSERT ... RETURNING yields the row or throws */
  if (!x) throw new Error('xpub insert failed');
  await audit(
    tx,
    { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'xpub.registered', targetType: 'merchant_xpub', targetId: x.id, before: prev ? brief(prev) : null, after },
    req,
  );
  return { kind: 'active', xpub: x };
}

async function resolveChange(tx: Tx, c: ChangeRow, status: 'applied' | 'cancelled' | 'failed', note: string, now: number): Promise<void> {
  await tx.update(xpubChanges).set({ status, resolvedAt: new Date(now), resolvedNote: note }).where(eq(xpubChanges.id, c.id));
}

/** Cancels a pending change. No step-up: cancelling only keeps the current key in place. */
export async function cancelXpubChange(deps: Deps, tx: Tx, actor: Actor, changeId: string, req: FastifyRequest): Promise<ChangeRow> {
  const [c] = await tx.select().from(xpubChanges).where(and(eq(xpubChanges.id, changeId), eq(xpubChanges.merchantId, actor.merchantId))).for('update');
  if (!c) throw new AppError('not_found', 'xpub change not found');
  if (c.status !== 'pending') throw new AppError('conflict', `xpub change is already ${c.status}`);
  await resolveChange(tx, c, 'cancelled', 'cancelled by merchant', deps.clock());
  await audit(tx, { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'xpub.change_cancelled', targetType: 'xpub_change', targetId: c.id }, req);
  const [out] = await tx.select().from(xpubChanges).where(eq(xpubChanges.id, c.id));
  /* v8 ignore next -- invariant: the row was locked above */
  if (!out) throw new Error('xpub change vanished');
  return out;
}

async function applyChange(deps: Deps, tx: Tx, c: ChangeRow): Promise<void> {
  const now = deps.clock();
  const [m] = await tx.select({ mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, c.merchantId));
  if (m?.mode !== 'non_custodial_xpub') throw new AppError('conflict', 'merchant is no longer in non-custodial xpub mode');
  const [prev] = await tx.select().from(merchantXpubs).where(activeOf(c.merchantId, c.livemode)).for('update');
  if (prev) await tx.update(merchantXpubs).set({ status: 'retired', retiredAt: new Date(now) }).where(eq(merchantXpubs.id, prev.id));
  const [x] = await tx
    .insert(merchantXpubs)
    .values({ merchantId: c.merchantId, family: c.family, livemode: c.livemode, xpub: c.xpub, keyFingerprint: c.keyFingerprint, ownershipProvedAt: c.ownershipProvedAt })
    .returning();
  /* v8 ignore next -- invariant: INSERT ... RETURNING yields the row or throws */
  if (!x) throw new Error('xpub insert failed');
  await resolveChange(tx, c, 'applied', 'cooldown elapsed', now);
  await audit(tx, {
    actorType: 'system',
    merchantId: c.merchantId,
    action: 'xpub.change_applied',
    targetType: 'merchant_xpub',
    targetId: x.id,
    before: prev ? brief(prev) : null,
    after: { change_id: c.id, livemode: c.livemode, fingerprint: c.keyFingerprint.slice(0, 16) },
  });
}

/**
 * Worker job: applies pending changes whose cooldown has elapsed. Each change runs in its own savepoint; one that can no
 * longer apply (merchant left xpub mode) is marked failed and audited. Safe on several workers.
 */
export async function applyDueXpubChanges(deps: Deps, batch = 50): Promise<{ applied: number; failed: number }> {
  return withSystem(deps.db, async (tx) => {
    const due = await tx
      .select()
      .from(xpubChanges)
      .where(and(eq(xpubChanges.status, 'pending'), lte(xpubChanges.activatesAt, new Date(deps.clock()))))
      .orderBy(asc(xpubChanges.activatesAt))
      .limit(batch)
      .for('update', { skipLocked: true });
    let applied = 0;
    let failed = 0;
    for (const c of due) {
      try {
        await tx.transaction((sp) => applyChange(deps, sp, c));
        applied++;
      } catch (err) {
        // The key itself cannot have been taken meanwhile (key_fingerprint_unique covers pending changes).
        if (!(err instanceof AppError)) throw err;
        const note = err.message;
        await resolveChange(tx, c, 'failed', note, deps.clock());
        await audit(tx, { actorType: 'system', merchantId: c.merchantId, action: 'xpub.change_failed', targetType: 'xpub_change', targetId: c.id, after: { note } });
        deps.log.error({ merchantId: c.merchantId, changeId: c.id, note }, 'xpub change could not be applied');
        failed++;
      }
    }
    return { applied, failed };
  });
}

/**
 * Which addresses of an xpub are in use, for the merchant's wallet: the largest run of unused indexes before a used one
 * is the gap limit the wallet must scan with, or it will not find later payments (expired invoices leave gaps).
 */
export async function derivationReport(tx: Tx, x: XpubRow, offset: number, limit: number) {
  const stats = await tx.execute<{ highest: string | null; max_gap: string | null }>(sql`
    with used as (
      select d.derivation_index as idx from ${depositAddresses} d join ${invoices} i on i.deposit_address_id = d.id
      where d.merchant_xpub_id = ${x.id} and exists (select 1 from payments p where p.invoice_id = i.id)
    )
    select max(idx)::text as highest, max(idx - prev - 1)::text as max_gap
    from (select idx, lag(idx, 1, -1) over (order by idx) as prev from used) t`);
  const s = stats.rows[0];
  const rows = await tx
    .select({
      index: depositAddresses.derivationIndex,
      address: depositAddresses.address,
      path: depositAddresses.derivationPath,
      chain: depositAddresses.chainId,
      invoiceId: invoices.id,
      status: invoices.status,
      received: invoices.amountReceived,
      decimals: tokens.decimals,
      symbol: tokens.symbol,
    })
    .from(depositAddresses)
    .leftJoin(invoices, eq(invoices.depositAddressId, depositAddresses.id))
    .leftJoin(tokens, eq(tokens.id, invoices.tokenId))
    .where(and(eq(depositAddresses.merchantXpubId, x.id), gte(depositAddresses.derivationIndex, offset), lt(depositAddresses.derivationIndex, offset + limit)))
    .orderBy(asc(depositAddresses.derivationIndex));
  return {
    xpub_id: x.id,
    next_index: x.nextIndex,
    highest_used_index: s?.highest ? Number(s.highest) : null,
    wallet_gap_limit: Math.max(MIN_WALLET_GAP_LIMIT, Number(s?.max_gap ?? 0) + 1),
    data: rows.map((r) => ({
      index: r.index,
      address: r.address,
      path: r.path,
      chain: r.chain,
      invoice_id: r.invoiceId,
      invoice_status: r.status,
      amount_received: r.received === null || r.decimals === null ? null : fromMinorUnits(r.received, r.decimals),
      symbol: r.symbol,
    })),
  };
}
