// BSC testnet only (chain id 97): deploy and use sastaUSDT, the test-mode stand-in for USDT (D-096).
// Signs with BSC_TESTNET_DEPLOYER_KEY from .env: a throwaway testnet wallet holding only faucet tBNB. Refuses any other chain.
//   pnpm testnet:token address               deployer address and tBNB balance
//   pnpm testnet:token deploy                deploy sastaUSDT, mint 1,000,000 to the deployer, print BSC_TESTNET_USDT_ADDRESS
//   pnpm testnet:token mint <to> <amount>    mint test tokens to any address (the mock's mint is open to anyone)
//   pnpm testnet:token pay <to> <amount>     send sastaUSDT from the deployer to a deposit address
//   pnpm testnet:token balance [address]     sastaUSDT balance (default: the deployer)
//   pnpm testnet:token send-bnb <to> <amount> send tBNB from the deployer (e.g. to fund the signer's gas wallet)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, formatEther, formatUnits, getAddress, http, isAddress, parseEther, parseUnits, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';

const NAME = 'sastaUSDT';
const SYMBOL = 'sastaUSDT';
const DECIMALS = 18;
const INITIAL_MINT = '1000000';
const FAUCET = 'https://www.bnbchain.org/en/testnet-faucet';

const out = (s: string) => process.stdout.write(`${s}\n`);

type Artifact = { abi: Abi; bytecode: Hex };
const mock = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../packages/chains/test/fixtures/mocks.json'), 'utf8')) as Record<string, Artifact>)
  .MockERC20 as Artifact;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

function deployer() {
  const key = env('BSC_TESTNET_DEPLOYER_KEY').trim();
  const hex = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  // Never echo the key, not even in part.
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('BSC_TESTNET_DEPLOYER_KEY must be a 32-byte hex private key');
  return privateKeyToAccount(hex);
}

function token(): Address {
  const a = env('BSC_TESTNET_USDT_ADDRESS');
  if (!isAddress(a)) throw new Error('BSC_TESTNET_USDT_ADDRESS is not an address');
  return getAddress(a);
}

function address(arg: string | undefined, what: string): Address {
  if (!arg || !isAddress(arg)) throw new Error(`${what} must be an 0x address`);
  return getAddress(arg);
}

function amount(arg: string | undefined): bigint {
  if (!arg || !/^\d+(\.\d{1,18})?$/.test(arg)) throw new Error('amount must be a decimal number, e.g. 25 or 25.50');
  return parseUnits(arg, DECIMALS);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const transport = http(env('BSC_TESTNET_RPC_URL'));
  const pub = createPublicClient({ chain: bscTestnet, transport });
  const chainId = await pub.getChainId();
  if (chainId !== bscTestnet.id) throw new Error(`BSC_TESTNET_RPC_URL is chain ${String(chainId)}, not BSC testnet (97)`);

  if (cmd === 'balance') {
    const who = args[0] ? address(args[0], 'address') : deployer().address;
    const bal = (await pub.readContract({ address: token(), abi: mock.abi, functionName: 'balanceOf', args: [who] })) as bigint;
    out(`${who}: ${formatUnits(bal, DECIMALS)} ${SYMBOL}`);
    return;
  }

  const account = deployer();
  const wallet = createWalletClient({ chain: bscTestnet, transport, account });
  const gas = await pub.getBalance({ address: account.address });
  const send = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`transaction reverted: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`);
    return r;
  };
  const needGas = () => {
    if (gas === 0n) throw new Error(`deployer ${account.address} has no tBNB for gas; get some at ${FAUCET}`);
  };

  if (cmd === 'address') {
    out(`deployer: ${account.address}\ntBNB:     ${formatEther(gas)}${gas === 0n ? `  (fund it at ${FAUCET})` : ''}`);
  } else if (cmd === 'deploy') {
    if (process.env.BSC_TESTNET_USDT_ADDRESS) {
      throw new Error('BSC_TESTNET_USDT_ADDRESS is already set: a registered token address cannot change (new token = new registry id)');
    }
    needGas();
    const hash = await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: [NAME, SYMBOL, DECIMALS] });
    const r = await send(hash);
    if (!r.contractAddress) throw new Error('deploy failed: no contract address in receipt');
    const addr = getAddress(r.contractAddress);
    await send(await wallet.writeContract({ address: addr, abi: mock.abi, functionName: 'mint', args: [account.address, parseUnits(INITIAL_MINT, DECIMALS)] }));
    out(`${SYMBOL} deployed by ${account.address}; it holds ${INITIAL_MINT} ${SYMBOL}.`);
    out(`explorer: ${bscTestnet.blockExplorers.default.url}/token/${addr}`);
    out(`Add to .env, then run pnpm db:seed and restart the watcher:\nBSC_TESTNET_USDT_ADDRESS=${addr}`);
  } else if (cmd === 'send-bnb') {
    needGas();
    const to = address(args[0], '<to>');
    if (!args[1] || !/^\d+(\.\d{1,18})?$/.test(args[1])) throw new Error('amount must be a decimal number of tBNB, e.g. 0.05');
    const value = parseEther(args[1]);
    if (value >= gas) throw new Error(`deployer holds only ${formatEther(gas)} tBNB`);
    const hash = await wallet.sendTransaction({ to, value });
    const r = await send(hash);
    out(`sent ${args[1]} tBNB to ${to} (block ${String(r.blockNumber)})`);
    out(`tx: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`);
  } else if (cmd === 'mint' || cmd === 'pay') {
    needGas();
    const to = address(args[0], '<to>');
    const value = amount(args[1]);
    const fn = cmd === 'mint' ? 'mint' : 'transfer';
    const hash = await wallet.writeContract({ address: token(), abi: mock.abi, functionName: fn, args: [to, value] });
    const r = await send(hash);
    out(`${cmd === 'mint' ? 'minted' : 'sent'} ${args[1] ?? ''} ${SYMBOL} to ${to} (block ${String(r.blockNumber)})`);
    out(`tx: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`);
  } else {
    throw new Error('commands: address | deploy | mint <to> <amount> | pay <to> <amount> | balance [address] | send-bnb <to> <amount>');
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
