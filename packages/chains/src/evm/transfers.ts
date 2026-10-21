// MONEY-CRITICAL
// Decodes ERC-20/BEP-20 Transfer logs. What this returns is what gets credited, so it is deliberately strict:
// exactly 3 topics (ERC-721 Transfer has 4), exactly 32 bytes of data, no removed/pending logs.
import type { Transfer } from '@gw/core';
import { getAddress } from 'viem';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string | bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: string | number | null;
  removed?: boolean;
}

const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/;
const DATA_RE = /^0x[0-9a-fA-F]{64}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function topicToAddress(topic: string): string | null {
  if (!TOPIC_RE.test(topic)) return null;
  // Upper 12 bytes must be zero for a valid address topic.
  if (!/^0x0{24}/.test(topic)) return null;
  return getAddress(`0x${topic.slice(26)}`);
}

function toBigInt(v: string | bigint | null): bigint | null {
  if (v === null) return null;
  if (typeof v === 'bigint') return v;
  return /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null;
}

function toIndex(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : /^0x[0-9a-fA-F]+$/.test(v) ? Number.parseInt(v, 16) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Returns null for anything that is not a well-formed, mined, non-removed fungible Transfer log. */
export function decodeTransferLog(chainId: string, log: RawLog): Transfer | null {
  if (log.removed) return null;
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!DATA_RE.test(log.data)) return null;
  const from = topicToAddress(log.topics[1] ?? '');
  const to = topicToAddress(log.topics[2] ?? '');
  const blockNumber = toBigInt(log.blockNumber);
  const logIndex = toIndex(log.logIndex);
  if (!from || !to || blockNumber === null || logIndex === null) return null;
  if (!log.blockHash || !HASH_RE.test(log.blockHash) || !log.transactionHash || !HASH_RE.test(log.transactionHash)) return null;
  return {
    chainId,
    tokenAddress: getAddress(log.address),
    from,
    to,
    amount: BigInt(log.data),
    txHash: log.transactionHash.toLowerCase(),
    logIndex,
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
  };
}

/** Decodes logs and keeps only those emitted by `tokenAddress` (never trust the RPC's address filter alone). */
export function decodeTokenTransfers(chainId: string, tokenAddress: string, logs: readonly RawLog[]): Transfer[] {
  const want = tokenAddress.toLowerCase();
  const out: Transfer[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== want) continue;
    const t = decodeTransferLog(chainId, log);
    if (t) out.push(t);
  }
  return out;
}
