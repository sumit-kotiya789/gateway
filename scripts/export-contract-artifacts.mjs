// Copies ABI + bytecode from contracts/out into committed files, so neither tests nor the app need a Solidity
// toolchain. Run after `pnpm contracts:build`.
//   - test mocks         -> packages/chains/test/fixtures/mocks.json
//   - forwarder (D-097)  -> packages/chains/src/evm/forwarder.artifacts.json (production: deployed and verified against)
import { readFileSync, writeFileSync } from 'node:fs';

const read = (file, name) => JSON.parse(readFileSync(`contracts/out/${file}/${name}.json`, 'utf8'));

const mockNames = ['MockERC20', 'FeeOnTransferERC20', 'FakeTransferEmitter'];
const mocks = {};
for (const n of mockNames) {
  const a = read('Mocks.sol', n);
  mocks[n] = { abi: a.abi, bytecode: a.bytecode.object };
}
writeFileSync('packages/chains/test/fixtures/mocks.json', JSON.stringify(mocks, null, 1) + '\n');

const fwd = read('Forwarder.sol', 'Forwarder');
const factory = read('ForwarderFactory.sol', 'ForwarderFactory');
const forwarder = {
  // creation code: what the factory deploys; the CREATE2 address commits to it (with the constructor arguments)
  Forwarder: { abi: fwd.abi, bytecode: fwd.bytecode.object },
  // deployedBytecode: chains:verify and the signer compare the on-chain factory code against it
  ForwarderFactory: { abi: factory.abi, bytecode: factory.bytecode.object, deployedBytecode: factory.deployedBytecode.object },
};
writeFileSync('packages/chains/src/evm/forwarder.artifacts.json', JSON.stringify(forwarder, null, 1) + '\n');
process.stdout.write(`exported ${mockNames.join(', ')}, Forwarder, ForwarderFactory\n`);
