// Copies ABI + bytecode of the test mocks from contracts/out into a committed fixture,
// so tests never need a Solidity toolchain. Run after `pnpm contracts:build`.
import { readFileSync, writeFileSync } from 'node:fs';

const names = ['MockERC20', 'FeeOnTransferERC20', 'FakeTransferEmitter'];
const out = {};
for (const n of names) {
  const a = JSON.parse(readFileSync(`contracts/out/Mocks.sol/${n}.json`, 'utf8'));
  out[n] = { abi: a.abi, bytecode: a.bytecode.object };
}
writeFileSync('packages/chains/test/fixtures/mocks.json', JSON.stringify(out, null, 1) + '\n');
process.stdout.write(`exported ${names.join(', ')}\n`);
