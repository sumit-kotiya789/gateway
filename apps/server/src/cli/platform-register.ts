// Registers the platform custody keys printed by the signer's `init-seed` (M7, D-088): `pnpm platform:register <file>`.
// Public values only (deposit xpubs, hot and gas addresses). Refuses to replace a different active key: replacing
// custody keys is a key ceremony, not a command. Idempotent for the same values.
import { readFileSync } from 'node:fs';
import { evmDeriver } from '@gw/chains';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { loadConfig } from '../common/config.js';
import { createDb, withSystem } from '../common/db.js';
import { platformWallets, walletAccounts } from '../db/schema.js';

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Path = z.string().regex(/^m(\/\d+'?)+$/);
const Input = z.strictObject({
  wallet_accounts: z.array(z.strictObject({ livemode: z.boolean(), base_path: Path, xpub: z.string().min(100).max(120) })),
  platform_wallets: z.array(z.strictObject({ kind: z.enum(['hot', 'gas']), livemode: z.boolean(), derivation_path: Path, address: Address })),
  // The cold multisig (not derived from the signer's seed). Also list it in the signer's SIGNER_COLD_ADDRESSES.
  cold_wallets: z.array(z.strictObject({ livemode: z.boolean(), address: Address })).default([]),
});

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: platform:register <signer init-seed output.json>');
  const input = Input.parse(JSON.parse(readFileSync(file, 'utf8')));
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    await withSystem(db, async (tx) => {
      for (const w of input.wallet_accounts) {
        evmDeriver.keyFingerprint(w.xpub); // validates: public account key only
        const [cur] = await tx.select().from(walletAccounts).where(and(eq(walletAccounts.family, 'evm'), eq(walletAccounts.livemode, w.livemode)));
        if (cur && cur.xpub !== w.xpub) throw new Error(`a different ${w.livemode ? 'live' : 'test'} deposit wallet is already registered`);
        if (cur) continue;
        const [row] = await tx
          .insert(walletAccounts)
          .values({ family: 'evm', livemode: w.livemode, basePath: w.base_path, xpub: w.xpub, keyFingerprint: evmDeriver.keyFingerprint(w.xpub) })
          .returning();
        /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
        if (!row) throw new Error('wallet account insert failed');
        await audit(tx, { actorType: 'system', action: 'custody.wallet_account_registered', targetType: 'wallet_account', targetId: row.id, after: { livemode: w.livemode, base_path: w.base_path } });
      }
      const all = [...input.platform_wallets, ...input.cold_wallets.map((c) => ({ ...c, kind: 'cold' as const, derivation_path: null }))];
      for (const p of all) {
        const [cur] = await tx
          .select()
          .from(platformWallets)
          .where(and(eq(platformWallets.family, 'evm'), eq(platformWallets.livemode, p.livemode), eq(platformWallets.kind, p.kind), isNull(platformWallets.retiredAt)));
        if (cur && cur.address.toLowerCase() !== p.address.toLowerCase()) throw new Error(`a different active ${p.kind} wallet is already registered`);
        if (cur) continue;
        const [row] = await tx.insert(platformWallets).values({ family: 'evm', livemode: p.livemode, kind: p.kind, address: p.address, derivationPath: p.derivation_path }).returning();
        /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
        if (!row) throw new Error('platform wallet insert failed');
        await audit(tx, { actorType: 'system', action: 'custody.platform_wallet_registered', targetType: 'platform_wallet', targetId: row.id, after: { kind: p.kind, livemode: p.livemode, address: p.address } });
      }
    });
  } finally {
    await pool.end();
  }
  process.stdout.write('platform custody keys registered\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
