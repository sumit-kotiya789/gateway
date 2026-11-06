// Local testing only (docker compose Anvil, chain id 31337): a mock USDT and test payments, signed with Anvil's
// published dev keys. Refuses any other chain.
//   pnpm dev:usdt deploy                      deploy Mock USDT, mint to dev accounts 1-3, print EVM_LOCAL_USDT_ADDRESS
//   pnpm dev:usdt pay <to> <amount> [from=1]  send USDT from dev account <from> (1-3) to a deposit address
//   pnpm dev:usdt payer [n=1]                 print dev account n's address (e.g. to block it in the admin console)
import { MOCK_ABI, anvilAccount, anvilClients, deploy } from '../../../../packages/chains/test/support/anvil.js';
import { getAddress, isAddress, parseUnits } from 'viem';

const url = process.env.EVM_LOCAL_RPC_URL ?? 'http://localhost:8545';
const [cmd, ...args] = process.argv.slice(2);
const out = (s: string) => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  const { pub } = anvilClients(url);
  if ((await pub.getChainId()) !== 31337) throw new Error(`${url} is not the local Anvil chain (31337)`);
  if (cmd === 'deploy') {
    const token = await deploy(url, 'MockERC20', ['Mock USDT', 'USDT', 18], anvilAccount(0));
    const { wallet } = anvilClients(url, anvilAccount(0));
    for (const i of [1, 2, 3]) {
      const hash = await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'mint', args: [anvilAccount(i).address, parseUnits('1000000', 18)] });
      await pub.waitForTransactionReceipt({ hash });
    }
    out(`Mock USDT deployed; dev accounts 1-3 hold 1,000,000 each.\nAdd to .env, then run pnpm db:seed:\nEVM_LOCAL_USDT_ADDRESS=${token}`);
  } else if (cmd === 'pay') {
    const [to, amount, from = '1'] = args;
    const token = process.env.EVM_LOCAL_USDT_ADDRESS;
    if (!to || !isAddress(to) || !amount || !token) throw new Error('usage: pay <to> <amount> [from=1]; EVM_LOCAL_USDT_ADDRESS must be set');
    const account = anvilAccount(Number(from));
    const { wallet } = anvilClients(url, account);
    const hash = await wallet.writeContract({ address: getAddress(token), abi: MOCK_ABI, functionName: 'transfer', args: [getAddress(to), parseUnits(amount, 18)] });
    const r = await pub.waitForTransactionReceipt({ hash });
    out(`sent ${amount} USDT from ${account.address} to ${to} (tx ${hash}, block ${String(r.blockNumber)})`);
  } else if (cmd === 'payer') {
    out(anvilAccount(Number(args[0] ?? '1')).address);
  } else {
    throw new Error('commands: deploy | pay <to> <amount> [from=1] | payer [n]');
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
