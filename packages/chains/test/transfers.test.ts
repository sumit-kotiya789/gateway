import { describe, expect, it } from 'vitest';
import { TRANSFER_TOPIC, decodeTokenTransfers, decodeTransferLog, type RawLog } from '../src/index.js';

const TOKEN = '0x55d398326f99059fF775485246999027B3197955';
const FROM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TO = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const topic = (addr: string) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;

function log(over: Partial<RawLog> = {}): RawLog {
  return {
    address: TOKEN.toLowerCase(),
    topics: [TRANSFER_TOPIC, topic(FROM), topic(TO)],
    data: word(25n * 10n ** 18n),
    blockNumber: '0x10',
    blockHash: `0x${'aa'.repeat(32)}`,
    transactionHash: `0x${'BB'.repeat(32)}`,
    logIndex: '0x3',
    removed: false,
    ...over,
  };
}

describe('decodeTransferLog', () => {
  it('decodes a standard ERC-20 Transfer with checksummed addresses', () => {
    expect(decodeTransferLog('bsc', log())).toEqual({
      chainId: 'bsc',
      tokenAddress: TOKEN,
      from: FROM,
      to: TO,
      amount: 25n * 10n ** 18n,
      txHash: `0x${'bb'.repeat(32)}`,
      logIndex: 3,
      blockNumber: 16n,
      blockHash: `0x${'aa'.repeat(32)}`,
    });
  });

  it('handles the full uint256 range exactly', () => {
    const max = (1n << 256n) - 1n;
    expect(decodeTransferLog('bsc', log({ data: word(max) }))?.amount).toBe(max);
    expect(decodeTransferLog('bsc', log({ data: word(0n) }))?.amount).toBe(0n);
  });

  it.each([
    ['ERC-721 (4 topics)', { topics: [TRANSFER_TOPIC, topic(FROM), topic(TO), word(1n)] }],
    ['non-indexed variant (1 topic)', { topics: [TRANSFER_TOPIC] }],
    ['other event', { topics: [`0x${'11'.repeat(32)}`, topic(FROM), topic(TO)] }],
    ['removed by reorg', { removed: true }],
    ['pending (no block hash)', { blockHash: null }],
    ['pending (no block number)', { blockNumber: null }],
    ['no tx hash', { transactionHash: null }],
    ['no log index', { logIndex: null }],
    ['short data', { data: '0x01' }],
    ['long data (two words)', { data: word(1n) + '0'.repeat(64) }],
    ['dirty address topic', { topics: [TRANSFER_TOPIC, `0x${'ff'.repeat(12)}${FROM.slice(2)}`, topic(TO)] }],
    ['malformed tx hash', { transactionHash: '0x1234' }],
  ])('rejects %s', (_name, over) => {
    expect(decodeTransferLog('bsc', log(over as Partial<RawLog>))).toBeNull();
  });
});

describe('decodeTransferLog field encodings', () => {
  it('accepts already-decoded bigint block numbers and numeric log indices', () => {
    expect(decodeTransferLog('bsc', log({ blockNumber: 16n, logIndex: 3 }))).toMatchObject({ blockNumber: 16n, logIndex: 3 });
  });

  it.each([
    ['non-hex block number', { blockNumber: '16' }],
    ['non-hex log index', { logIndex: '0xZZ' }],
    ['negative log index', { logIndex: -1 }],
    ['fractional log index', { logIndex: 1.5 }],
    ['non-hex topic', { topics: [TRANSFER_TOPIC, `0x${'zz'.repeat(32)}`, topic(TO)] }],
    ['short topic', { topics: [TRANSFER_TOPIC, '0x1234', topic(TO)] }],
    ['malformed block hash', { blockHash: '0xabc' }],
  ])('rejects %s', (_name, over) => {
    expect(decodeTransferLog('bsc', log(over as Partial<RawLog>))).toBeNull();
  });
});

describe('decodeTokenTransfers', () => {
  it('skips malformed logs even from the right contract', () => {
    expect(decodeTokenTransfers('bsc', TOKEN, [log({ data: '0x' }), log()])).toHaveLength(1);
  });

  it('keeps only logs emitted by the exact token contract (spoof defense)', () => {
    const fake = log({ address: '0x000000000000000000000000000000000000dEaD' });
    const out = decodeTokenTransfers('bsc', TOKEN, [log(), fake, log({ logIndex: '0x4' })]);
    expect(out.map((t) => t.logIndex)).toEqual([3, 4]);
    expect(out.every((t) => t.tokenAddress === TOKEN)).toBe(true);
  });

  it('matches the token address case-insensitively', () => {
    expect(decodeTokenTransfers('bsc', TOKEN.toLowerCase(), [log({ address: TOKEN })])).toHaveLength(1);
  });
});
