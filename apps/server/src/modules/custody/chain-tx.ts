// Broadcasting and tracking custody transactions (M7c). The worker sends the bytes the signer returned and polls their
// receipts; it never builds or signs a transaction itself.
import { resolveRpcUrls } from '@gw/chains';
import { createPublicClient, fallback, http, type Hex, type PublicClient } from 'viem';

export interface Receipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
}

export interface ChainTx {
  /** Broadcasts signed bytes. "Already known" and "nonce too low" (it was mined) are not errors for a rebroadcast. */
  sendRaw(raw: string): Promise<void>;
  receipt(txHash: string): Promise<Receipt | null>;
  blockNumber(): Promise<bigint>;
  nativeBalance(address: string): Promise<bigint>;
}

const BENIGN = /already known|known transaction|nonce too low|already imported/i;

export function viemChainTx(urls: string[]): ChainTx {
  const client: PublicClient = createPublicClient({ transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 }))) });
  return {
    async sendRaw(raw) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw as Hex });
      } catch (err) {
        if (!BENIGN.test((err as Error).message)) throw err;
      }
    },
    async receipt(txHash) {
      try {
        const r = await client.getTransactionReceipt({ hash: txHash as Hex });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (err) {
        if ((err as Error).name === 'TransactionReceiptNotFoundError') return null;
        throw err;
      }
    },
    blockNumber: () => client.getBlockNumber(),
    nativeBalance: (address) => client.getBalance({ address: address as Hex }),
  };
}

export function chainTxFor(rpcUrlTemplates: string[], env: Record<string, string | undefined> = process.env): ChainTx {
  const { urls } = resolveRpcUrls(rpcUrlTemplates, env);
  if (urls.length === 0) throw new Error('no usable RPC URL for this chain');
  return viemChainTx(urls);
}
