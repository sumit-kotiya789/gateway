// Deploys the ForwarderFactory (D-097) on BSC testnet: `pnpm forwarder:deploy`. Signs with BSC_TESTNET_DEPLOYER_KEY (the
// throwaway testnet wallet from .env). Refuses any other chain: mainnet only after the contract audit, deliberately.
// The factory is stateless and permissionless; whoever deploys it has no power over it or the forwarders it creates.
import { FORWARDER_FACTORY_ABI, FORWARDER_FACTORY_BYTECODE, FORWARDER_FACTORY_CODEHASH } from '@gw/chains';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';

const out = (s: string) => process.stdout.write(`${s}\n`);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

async function main(): Promise<void> {
  if (process.env.BSC_TESTNET_FORWARDER_FACTORY) {
    throw new Error('BSC_TESTNET_FORWARDER_FACTORY is already set: a chain\'s factory is set once (new factory = new deposit addresses)');
  }
  const key = env('BSC_TESTNET_DEPLOYER_KEY').trim();
  const hex = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  // Never echo the key, not even in part.
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('BSC_TESTNET_DEPLOYER_KEY must be a 32-byte hex private key');
  const account = privateKeyToAccount(hex);
  const transport = http(env('BSC_TESTNET_RPC_URL'));
  const pub = createPublicClient({ chain: bscTestnet, transport });
  const chainId = await pub.getChainId();
  if (chainId !== bscTestnet.id) throw new Error(`BSC_TESTNET_RPC_URL is chain ${String(chainId)}, not BSC testnet (97)`);
  const gas = await pub.getBalance({ address: account.address });
  if (gas === 0n) throw new Error(`deployer ${account.address} has no tBNB for gas`);

  const wallet = createWalletClient({ chain: bscTestnet, transport, account });
  const hash = await wallet.deployContract({ abi: FORWARDER_FACTORY_ABI, bytecode: FORWARDER_FACTORY_BYTECODE, args: [] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy failed: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`);
  const factory = getAddress(r.contractAddress);
  const code = await pub.getCode({ address: factory });
  if (!code || keccak256(code) !== FORWARDER_FACTORY_CODEHASH) throw new Error('deployed code does not match the committed artifact');

  out(`ForwarderFactory deployed by ${account.address} (gas used ${String(r.gasUsed)}, tBNB left ${formatEther(await pub.getBalance({ address: account.address }))})`);
  out(`explorer: ${bscTestnet.blockExplorers.default.url}/address/${factory}`);
  out(`Add to .env, then run pnpm db:seed and pnpm chains:verify:\nBSC_TESTNET_FORWARDER_FACTORY=${factory}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
