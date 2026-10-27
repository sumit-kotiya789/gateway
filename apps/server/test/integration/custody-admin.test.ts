import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { createSigner } from '../../../signer/src/signer.js';
import { FakeChain, signerPool, withSwitchLock } from './custody-sim.js';
import { TEST_MNEMONIC, adminAgent, buildTestApp, ensureLocalRegistry, ensurePlatformCustody, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const owner = ownerPool();
let pool: pg.Pool;
beforeAll(async () => {
  await t.app.ready();
  await ensureLocalRegistry(owner);
  await ensurePlatformCustody(owner);
  pool = await signerPool(owner);
});
afterAll(async () => {
  await owner.query('update signer_controls set paused = false where id = 1');
  await pool.end();
  await t.close();
  await owner.end();
});

describe('custody console', () => {
  it('overview: signer state, platform wallets, custody totals', async () => {
    const op = await adminAgent(t, owner, 'auditor');
    const r = await op.agent.req('GET', '/admin/v1/custody/');
    expect(r.statusCode).toBe(200);
    const body = r.json<{ custodial_enabled: boolean; signer: { paused: boolean }; wallets: { kind: string; livemode: boolean }[]; balances: unknown[] }>();
    expect(body.custodial_enabled).toBe(true);
    expect(body.wallets.map((w) => `${w.kind}:${String(w.livemode)}`)).toEqual(expect.arrayContaining(['hot:false', 'gas:false', 'hot:true', 'gas:true']));
  });

  it('kill switch: any operator pauses at once; only a superadmin with a fresh code resumes; the signer obeys', async () => {
    const op = await adminAgent(t, owner, 'operator');
    const sa = await adminAgent(t, owner, 'superadmin');
    const auditor = await adminAgent(t, owner, 'auditor');
    const config = loadSignerConfig({ SIGNER_DATABASE_URL: 'postgres://unused@localhost/db', SIGNER_HMAC_SECRET: 'h'.repeat(32), SIGNER_SEED_FILE: '/unused', SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64') });
    const signer = createSigner({ pool, keyring: Keyring.fromMnemonic(TEST_MNEMONIC), config, rpcFor: () => new FakeChain().rpc });
    // Exclusive: no other test file signs while the global switch is off.
    await withSwitchLock(pool, 'exclusive', async () => {
      expect((await auditor.agent.req('POST', '/admin/v1/custody/signer/pause', { reason: 'drill' })).statusCode).toBe(403);
      expect((await op.agent.req('POST', '/admin/v1/custody/signer/pause', { reason: 'incident drill' })).statusCode).toBe(204);
      try {
        expect((await op.agent.req('GET', '/admin/v1/custody/')).json()).toMatchObject({ signer: { paused: true, reason: 'incident drill' } });
        await expect(signer.sign({ kind: 'sweep', id: '00000000-0000-7000-8000-000000000000' })).rejects.toMatchObject({ code: 'paused' });
        expect((await op.agent.req('POST', '/admin/v1/custody/signer/pause', { reason: 'again' })).statusCode).toBe(409);
        expect((await op.agent.req('POST', '/admin/v1/custody/signer/resume', { reason: 'all clear' }, op.stepUp())).statusCode).toBe(403);
        expect((await sa.agent.req('POST', '/admin/v1/custody/signer/resume', { reason: 'all clear' })).statusCode).toBe(403); // no code
        expect((await sa.agent.req('POST', '/admin/v1/custody/signer/resume', { reason: 'all clear' }, sa.stepUp())).statusCode).toBe(204);
      } finally {
        await owner.query('update signer_controls set paused = false where id = 1');
      }
    });
    const audit = await owner.query<{ action: string }>("select action from audit_logs where action like 'custody.signer_%' and actor_id in ($1, $2) order by seq", [op.id, sa.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['custody.signer_paused', 'custody.signer_resumed']);
    expect((await sa.agent.req('POST', '/admin/v1/custody/signer/resume', { reason: 'again' }, sa.stepUp())).statusCode).toBe(409);
  });
});
