// Picks the configured seed source (config.ts checked its settings): `local-file` (dev/test) or `openbao` (D-093).
import type { SeedSettings } from './config.js';
import { OpenBaoSeed } from './openbao.js';
import { LocalFileSeed, type SeedSource } from './seed.js';

export function seedSource(s: SeedSettings): SeedSource {
  return s.source === 'openbao' ? new OpenBaoSeed(s.file, s.openbao) : new LocalFileSeed(s.file, s.kek);
}

/** Creates the configured source's seed (init-seed). Returns the mnemonic, for the offline backup only. */
export function createSeed(s: SeedSettings): Promise<string> {
  return s.source === 'openbao' ? OpenBaoSeed.create(s.file, s.openbao) : LocalFileSeed.create(s.file, s.kek);
}
