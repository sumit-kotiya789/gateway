// Read-only chain access the signer needs to build a transaction: chain id check, nonce, gas price, balances.
// The signer never broadcasts: the worker does, so a compromised network path cannot make the signer send anything.
import { resolveRpcUrls } from '@gw/chains';
import { createPublicClient, erc20Abi, fallback, http, type PublicClient } from 'viem';

export interface ChainRpc {
  chainId(): Promise<number>;
  /** Next nonce including pending transactions. */
  pendingNonce(address: string): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  nativeBalance(address: string): Promise<bigint>;
  tokenBalance(token: string, address: string): Promise<bigint>;
}

export function viemRpc(urls: string[]): ChainRpc {
  const client: PublicClient = createPublicClient({ transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 }))) });
  return {
    chainId: () => client.getChainId(),
    pendingNonce: async (address) => BigInt(await client.getTransactionCount({ address: address as `0x${string}`, blockTag: 'pending' })),
    gasPrice: () => client.getGasPrice(),
    nativeBalance: (address) => client.getBalance({ address: address as `0x${string}` }),
    tokenBalance: (token, address) =>
      client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [address as `0x${string}`] }),
  };
}

/** RPC for a chain row: URL templates resolved from the signer's own environment (provider keys never in the DB). */
export function rpcFor(rpcUrlTemplates: string[], env: Record<string, string | undefined>): ChainRpc {
  const { urls } = resolveRpcUrls(rpcUrlTemplates, env);
  if (urls.length === 0) throw new Error('no usable RPC URL for this chain in the signer environment');
  return viemRpc(urls);
}
