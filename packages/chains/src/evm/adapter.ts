import type { BlockInfo, ChainAdapter, ChainConfig, FeeEstimate, Receipt, TokenConfig, Transfer, TxRequest } from '@gw/core';
import {
  createPublicClient,
  erc20Abi,
  fallback,
  getAddress,
  http,
  isAddress,
  numberToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { TRANSFER_TOPIC, decodeTokenTransfers, decodeTransferLog, type RawLog } from './transfers.js';

export interface EvmAdapterOptions {
  timeoutMs?: number;
}

/** Multi-RPC failover: providers are tried in order; each has its own timeout and one retry. */
export function createEvmAdapter(chain: ChainConfig, rpcUrls: readonly string[], opts: EvmAdapterOptions = {}): ChainAdapter {
  if (chain.family !== 'evm') throw new Error(`chain ${chain.id} is not EVM`);
  if (rpcUrls.length === 0) throw new Error(`chain ${chain.id} has no usable RPC URL`);
  const timeout = opts.timeoutMs ?? 10_000;
  const client: PublicClient = createPublicClient({
    transport: fallback(
      rpcUrls.map((u) => http(u, { timeout, retryCount: 1 })),
      { retryCount: 1 },
    ),
  });

  return {
    chainId: chain.id,
    family: 'evm',

    getNetworkId: async () => String(await client.getChainId()),

    getLatestBlock: () => client.getBlockNumber({ cacheTime: 0 }),

    async getFinalizedBlock() {
      if (chain.finality !== 'tag') return null;
      try {
        const b = await client.getBlock({ blockTag: 'finalized' });
        return b.number;
      } catch {
        return null; // RPC without finality support: caller falls back to confirmation count (D-008)
      }
    },

    async getBlock(n): Promise<BlockInfo> {
      const b = await client.getBlock({ blockNumber: n });
      return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
    },

    async getTokenTransfers(token: TokenConfig, from: bigint, to: bigint): Promise<Transfer[]> {
      if (to < from) return [];
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ address: token.contractAddress as Hex, topics: [TRANSFER_TOPIC], fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
      });
      return decodeTokenTransfers(chain.id, token.contractAddress, logs as unknown as RawLog[]).filter(
        (t) => t.blockNumber >= from && t.blockNumber <= to,
      );
    },

    async getBalance(address, token) {
      const a = getAddress(address);
      if (!token) return client.getBalance({ address: a });
      return client.readContract({ address: getAddress(token.contractAddress), abi: erc20Abi, functionName: 'balanceOf', args: [a] });
    },

    async getTransactionReceipt(hash): Promise<Receipt | null> {
      const r = await client.request({ method: 'eth_getTransactionReceipt', params: [hash as Hex] });
      if (!r) return null;
      const transfers: Transfer[] = [];
      for (const log of r.logs as unknown as RawLog[]) {
        const t = decodeTransferLog(chain.id, log);
        if (t) transfers.push(t);
      }
      return {
        txHash: r.transactionHash.toLowerCase(),
        status: r.status === '0x1' ? 'success' : 'reverted',
        blockNumber: BigInt(r.blockNumber),
        blockHash: r.blockHash.toLowerCase(),
        transfers,
      };
    },

    readTokenDecimals: (token) =>
      client.readContract({ address: getAddress(token.contractAddress), abi: erc20Abi, functionName: 'decimals' }),

    async estimateFee(tx: TxRequest): Promise<FeeEstimate> {
      const [gasLimit, fees] = await Promise.all([
        client.estimateGas({
          account: getAddress(tx.from),
          to: getAddress(tx.to),
          ...(tx.data ? { data: tx.data as Hex } : {}),
          ...(tx.value === undefined ? {} : { value: tx.value }),
        }),
        client.estimateFeesPerGas(),
      ]);
      return { gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxTotal: gasLimit * fees.maxFeePerGas };
    },

    broadcast: (signedTx) => client.sendRawTransaction({ serializedTransaction: signedTx as Hex }),

    isValidAddress: (addr) => isAddress(addr, { strict: true }),

    normalizeAddress: (addr) => getAddress(addr),
  };
}
