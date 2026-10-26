import { randomBytes } from 'node:crypto';
import { evmDeriver } from '@gw/chains';
import { HDKey, hdKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyDueXpubChanges, XPUB_CHANGE_COOLDOWN_MS } from '../../src/modules/xpubs/xpubs.js';
import { runMaintenanceJob } from '../../src/main-worker.js';
import { buildTestApp, enable2fa, ensureLocalRegistry, ownerPool, signup, totpNow } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function ownerWith2fa() {
  const s = await signup(app);
  const { secret } = await enable2fa(s.agent, clock);
  const code = () => {
    clock.advance(30_000);
    return { 'x-totp-code': totpNow(secret, clock()) };
  };
  return { ...s, code };
}

/** A fresh wallet: its account xpub and a signer for the key at 0/0 (what MetaMask's first account holds). */
function wallet() {
  const master = HDKey.fromMasterSeed(randomBytes(32));
  const signer = hdKeyToAccount(master, { accountIndex: 0, addressIndex: 0 });
  return { xpub: master.derive("m/44'/60'/0'").publicExtendedKey, signer };
}

type Owner = Awaited<ReturnType<typeof ownerWith2fa>>;
interface XpubList {
  data: { id: string; status: string; first_address: string; ownership_proved_at: string | null }[];
  pending_change: { id: string } | null;
}
interface Report {
  next_index: number;
  highest_used_index: number | null;
  wallet_gap_limit: number;
  data: { index: number; address: string; invoice_id: string | null }[];
}

/** Preview (which issues the challenge), sign it with `signer`, register. */
async function registerProved(s: Owner, w: ReturnType<typeof wallet>, livemode = true, signer = w.signer) {
  const p = await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub: w.xpub, livemode });
  expect(p.statusCode).toBe(200);
  const ch = p.json<{ ownership_challenge: { message: string; issued_at: string; address: string } }>().ownership_challenge;
  const signature = await signer.signMessage({ message: ch.message });
  return s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode, xpub: w.xpub, ownership: { issued_at: ch.issued_at, signature } }, s.code());
}

const secretAudits = (merchantId: string) =>
  owner.query<{ after: { kind: string } }>("select after from audit_logs where merchant_id = $1 and action = 'security.secret_submitted' order by seq", [merchantId]);

describe('secret material pasted as an xpub', () => {
  const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

  it('is refused on preview and register, recorded by kind only, never echoed', async () => {
    const s = await ownerWith2fa();
    const pre = await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub: mnemonic });
    expect(pre.statusCode).toBe(400);
    expect(pre.json().error.details).toEqual({ reason: 'secret_material', kind: 'mnemonic' });
    expect(pre.body).not.toContain('sausage');

    const hex = randomBytes(32).toString('hex');
    const reg = await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: hex }, s.code());
    expect(reg.json().error.details.kind).toBe('hex_private_key');

    const rows = (await secretAudits(s.merchantId)).rows;
    expect(rows.map((r) => r.after.kind)).toEqual(['mnemonic', 'hex_private_key']);
    expect(JSON.stringify(rows)).not.toContain('sausage');
    expect(JSON.stringify(rows)).not.toContain(hex);
  });
});

describe('ownership proof', () => {
  it('preview returns a challenge naming the merchant, mode and address 0/0', async () => {
    const s = await ownerWith2fa();
    const w = wallet();
    const r = (await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub: w.xpub, livemode: true })).json();
    expect(r.ownership_challenge.address).toBe(w.signer.address);
    expect(r.ownership_challenge.message).toContain(`Merchant: ${s.merchantId}`);
    expect(r.ownership_challenge.message).toContain('my live payments');
    expect(r.ownership_challenge.message).toContain(`Address (0/0): ${w.signer.address}`);
  });

  it('live keys need it; a valid signature registers the key with the proof time', async () => {
    const s = await ownerWith2fa();
    const w = wallet();
    const bare = await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: true, xpub: w.xpub }, s.code());
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.details.reason).toBe('proof_required');

    const r = await registerProved(s, w);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ livemode: true, status: 'active', first_address: w.signer.address });
    expect(r.json().ownership_proved_at).not.toBeNull();
    const a = await owner.query<{ after: { ownership_proved: boolean } }>("select after from audit_logs where merchant_id = $1 and action = 'xpub.registered'", [s.merchantId]);
    expect(a.rows[0]?.after.ownership_proved).toBe(true);
  });

  it('a signature from another key, a stale challenge, or garbage is refused', async () => {
    const s = await ownerWith2fa();
    const w = wallet();
    expect((await registerProved(s, w, true, wallet().signer)).json().error.details.reason).toBe('proof_mismatch');

    const p = (await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub: w.xpub, livemode: true })).json();
    const signature = await w.signer.signMessage({ message: p.ownership_challenge.message });
    clock.advance(16 * 60_000);
    const stale = await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: true, xpub: w.xpub, ownership: { issued_at: p.ownership_challenge.issued_at, signature } }, s.code());
    expect(stale.json().error.details.reason).toBe('proof_expired');

    const future = new Date(clock() + 5 * 60_000).toISOString();
    const early = await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: true, xpub: w.xpub, ownership: { issued_at: future, signature } }, s.code());
    expect(early.json().error.details.reason).toBe('proof_expired');

    const garbage = await s.agent.req(
      'POST',
      '/v1/dashboard/xpubs/',
      { livemode: true, xpub: w.xpub, ownership: { issued_at: new Date(clock()).toISOString(), signature: `0x${'00'.repeat(65)}` } },
      s.code(),
    );
    expect(garbage.json().error.details.reason).toBe('proof_invalid');
  });

  it('a proof signed for test mode does not register a live key', async () => {
    const s = await ownerWith2fa();
    const w = wallet();
    const p = (await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub: w.xpub, livemode: false })).json();
    const signature = await w.signer.signMessage({ message: p.ownership_challenge.message });
    const r = await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: true, xpub: w.xpub, ownership: { issued_at: p.ownership_challenge.issued_at, signature } }, s.code());
    expect(r.json().error.details.reason).toBe('proof_mismatch');
  });

  it('test keys may skip it; a proof given in test mode is still checked and recorded', async () => {
    const s = await ownerWith2fa();
    expect((await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: wallet().xpub }, s.code())).json().ownership_proved_at).toBeNull();
    const r = await registerProved(s, wallet(), false);
    expect(r.statusCode).toBe(201);
    expect(r.json().ownership_proved_at).not.toBeNull();
    expect((await registerProved(s, wallet(), false, wallet().signer)).statusCode).toBe(400);
  });
});

describe('live xpub change cooldown', () => {
  async function liveMerchant() {
    const s = await ownerWith2fa();
    const first = wallet();
    expect((await registerProved(s, first)).statusCode).toBe(201);
    return { s, first };
  }

  it('replacing a live key is queued; the old key serves until the worker applies it after the cooldown', async () => {
    const { s, first } = await liveMerchant();
    const second = wallet();
    const r = await registerProved(s, second);
    expect(r.statusCode).toBe(202);
    const change = r.json<{ pending_change: { id: string; activates_at: string } }>().pending_change;
    expect(change).toMatchObject({ status: 'pending', first_address: second.signer.address });
    expect(Date.parse(change.activates_at) - clock()).toBeGreaterThan(XPUB_CHANGE_COOLDOWN_MS - 120_000);

    expect((await registerProved(s, wallet())).statusCode).toBe(409); // one pending change at a time
    const list = (await s.agent.req('GET', '/v1/dashboard/xpubs/?livemode=true')).json<XpubList>();
    expect(list.data.map((x) => x.first_address)).toEqual([first.signer.address]);
    expect(list.pending_change?.id).toBe(change.id);

    expect(await applyDueXpubChanges(deps)).toEqual({ applied: 0, failed: 0 }); // not due yet
    clock.advance(XPUB_CHANGE_COOLDOWN_MS);
    const job = (await runMaintenanceJob(deps, 'apply-xpub-changes')) as { applied: number };
    expect(job.applied).toBeGreaterThanOrEqual(1);

    const after = (await s.agent.req('GET', '/v1/dashboard/xpubs/?livemode=true')).json<XpubList>();
    expect(after.data.map((x) => [x.status, x.first_address])).toEqual([
      ['active', second.signer.address],
      ['retired', first.signer.address],
    ]);
    expect(after.data[0]?.ownership_proved_at).not.toBeNull();
    expect(after.pending_change).toBeNull();
    const audit = await owner.query<{ action: string }>("select action from audit_logs where merchant_id = $1 and action like 'xpub.%' order by seq", [s.merchantId]);
    expect(audit.rows.map((x) => x.action)).toEqual(['xpub.registered', 'xpub.change_requested', 'xpub.change_applied']);
    const mails = await owner.query<{ kind: string }>("select kind from email_outbox where merchant_id = $1 and kind like 'xpub_%' order by created_at", [s.merchantId]);
    expect(mails.rows.map((x) => x.kind)).toEqual(['xpub_change_requested', 'xpub_change_applied']);
  });

  it('a pending change can be cancelled once; nobody else can cancel it', async () => {
    const { s } = await liveMerchant();
    const id = (await registerProved(s, wallet())).json().pending_change.id;
    const other = await ownerWith2fa();
    expect((await other.agent.req('POST', `/v1/dashboard/xpubs/changes/${id}/cancel`)).statusCode).toBe(404);
    const c = await s.agent.req('POST', `/v1/dashboard/xpubs/changes/${id}/cancel`);
    expect(c.json()).toMatchObject({ status: 'cancelled', resolved_note: 'cancelled by merchant' });
    expect((await s.agent.req('POST', `/v1/dashboard/xpubs/changes/${id}/cancel`)).statusCode).toBe(409);
    clock.advance(XPUB_CHANGE_COOLDOWN_MS);
    await applyDueXpubChanges(deps);
    expect((await s.agent.req('GET', '/v1/dashboard/xpubs/?livemode=true')).json().data).toHaveLength(1);
    expect((await registerProved(s, wallet())).statusCode).toBe(202); // a new change may be requested afterwards
  });

  it('a key waiting in another merchant’s cooldown cannot be registered', async () => {
    const { s } = await liveMerchant();
    const w = wallet();
    expect((await registerProved(s, w)).statusCode).toBe(202);
    const other = await ownerWith2fa();
    expect((await registerProved(other, w)).statusCode).toBe(409);
    expect((await registerProved(other, w, false)).statusCode).toBe(409);
  });

  it('a change that can no longer apply is marked failed and audited', async () => {
    const { s } = await liveMerchant();
    const id = (await registerProved(s, wallet())).json().pending_change.id;
    await owner.query("update merchants set custody_mode = 'custodial' where id = $1", [s.merchantId]);
    clock.advance(XPUB_CHANGE_COOLDOWN_MS);
    const r = await applyDueXpubChanges(deps);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    const c = await owner.query<{ status: string; resolved_note: string }>('select status, resolved_note from xpub_changes where id = $1', [id]);
    expect(c.rows[0]).toEqual({ status: 'failed', resolved_note: 'merchant is no longer in non-custodial xpub mode' });
    const a = await owner.query("select 1 from audit_logs where merchant_id = $1 and action = 'xpub.change_failed'", [s.merchantId]);
    expect(a.rowCount).toBe(1);
    expect((await owner.query("select 1 from email_outbox where merchant_id = $1 and kind = 'xpub_change_failed'", [s.merchantId])).rowCount).toBe(1);
  });

  it('the database keeps resolved change requests and proofs immutable', async () => {
    const { s } = await liveMerchant();
    const id = (await registerProved(s, wallet())).json().pending_change.id;
    await expect(owner.query("update xpub_changes set activates_at = now() where id = $1", [id])).rejects.toThrow(/immutable/);
    await owner.query("update xpub_changes set status = 'cancelled', resolved_at = now() where id = $1", [id]);
    await expect(owner.query("update xpub_changes set status = 'pending', resolved_at = null where id = $1", [id])).rejects.toThrow(/already resolved/);
    await expect(owner.query('update merchant_xpubs set ownership_proved_at = now() where merchant_id = $1', [s.merchantId])).rejects.toThrow(/ownership proof is immutable/);
  });
});

describe('derivation visibility', () => {
  it('lists derived addresses with their invoices and the wallet gap limit to scan with', async () => {
    const s = await ownerWith2fa();
    const w = wallet();
    expect((await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: w.xpub }, s.code())).statusCode).toBe(201);
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const inv = await s.agent.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '5', token: 'evm-local:usdt' });
      expect(inv.statusCode).toBe(201);
      ids.push(inv.json<{ id: string }>().id);
    }
    const xpubId = (await s.agent.req('GET', '/v1/dashboard/xpubs/?livemode=false')).json<XpubList>().data[0]?.id ?? '';
    const empty = (await s.agent.req('GET', `/v1/dashboard/xpubs/${xpubId}/addresses`)).json<Report>();
    expect(empty).toMatchObject({ next_index: 23, highest_used_index: null, wallet_gap_limit: 20 });
    expect(empty.data.map((r) => [r.index, r.address, r.invoice_id])).toEqual(
      ids.map((id, i) => [i, evmDeriver.deriveFromXpub(w.xpub, i).address, id]),
    );

    // a payment arrives at index 22 only: the 22 unused addresses before it need a gap limit of 23
    const inv = await owner.query<{ deposit_address: string }>('select deposit_address from invoices where id = $1', [ids[22]]);
    await owner.query(
      `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
       values (gen_random_uuid(), $1, false, $2, 'evm-local', 'evm-local:usdt', $3, 0, $4, $5, 1, 1, '0x01', now(), 2)`,
      [s.merchantId, ids[22], `0x${randomBytes(32).toString('hex')}`, w.signer.address, inv.rows[0]?.deposit_address],
    );
    const used = (await s.agent.req('GET', `/v1/dashboard/xpubs/${xpubId}/addresses?offset=1&limit=1`)).json<Report>();
    expect(used).toMatchObject({ highest_used_index: 22, wallet_gap_limit: 23 });
    expect(used.data.map((r) => r.index)).toEqual([1]);

    const other = await ownerWith2fa();
    expect((await other.agent.req('GET', `/v1/dashboard/xpubs/${xpubId}/addresses`)).statusCode).toBe(404);
  });
});
