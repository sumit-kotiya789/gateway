// MONEY-CRITICAL
// Forwarder custody mode (D-097). The deposit address is the CREATE2 address of a Forwarder whose constructor
// arguments (merchant, fee recipient, invoice token, fee rate, fee cap) are part of the address: whatever arrives there
// can only ever go to that merchant, minus the capped fee. This file must agree exactly with ForwarderFactory.predict
// and Forwarder.flush (contracts/src); parity is tested against the deployed contracts on Anvil.
import {
  concat,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import artifacts from './forwarder.artifacts.json' with { type: 'json' };

export const FORWARDER_ABI = artifacts.Forwarder.abi as Abi;
export const FORWARDER_FACTORY_ABI = artifacts.ForwarderFactory.abi as Abi;
/** Creation code of the factory (deployed by `pnpm forwarder:deploy`). */
export const FORWARDER_FACTORY_BYTECODE = artifacts.ForwarderFactory.bytecode as Hex;
/** keccak256 of the factory's runtime code: a registered factory must have exactly this code on-chain. */
export const FORWARDER_FACTORY_CODEHASH = keccak256(artifacts.ForwarderFactory.deployedBytecode as Hex);
const FORWARDER_CREATION_CODE = artifacts.Forwarder.bytecode as Hex;

const BPS = 10_000n;
const UINT256_MAX = 2n ** 256n - 1n;

export interface ForwarderParams {
  merchant: string;
  feeRecipient: string;
  token: string;
  feeBps: number;
  feeCap: bigint;
}

/** Throws on anything the contract would refuse (or that would make a different address than intended). */
export function checkForwarderParams(p: ForwarderParams): void {
  for (const [k, v] of [['merchant', p.merchant], ['feeRecipient', p.feeRecipient], ['token', p.token]] as const) {
    // strict: a mixed-case address must carry a valid EIP-55 checksum (a typo there is caught, not paid out).
    if (!isAddress(v, { strict: true }) || /^0x0{40}$/i.test(v)) throw new Error(`forwarder ${k} must be a non-zero address`);
  }
  if (!Number.isInteger(p.feeBps) || p.feeBps < 0 || p.feeBps > 10_000) throw new Error('forwarder feeBps must be an integer in [0, 10000]');
  if (p.feeCap < 0n || p.feeCap > UINT256_MAX) throw new Error('forwarder feeCap out of range');
}

/** Per-deposit-address salt: the deposit address row id, so every invoice gets its own address. */
export function forwarderSalt(depositAddressId: string): Hex {
  return keccak256(stringToHex(`gateway:forwarder:${depositAddressId}`));
}

function constructorArgs(p: ForwarderParams): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint16' }, { type: 'uint256' }],
    [getAddress(p.merchant), getAddress(p.feeRecipient), getAddress(p.token), p.feeBps, p.feeCap],
  );
}

/** Same as ForwarderFactory.predict(salt, ...): where the forwarder for these arguments lives. */
export function forwarderAddress(factory: string, salt: Hex, p: ForwarderParams): Address {
  checkForwarderParams(p);
  const bytecodeHash = keccak256(concat([FORWARDER_CREATION_CODE, constructorArgs(p)]));
  return getContractAddress({ opcode: 'CREATE2', from: getAddress(factory), salt, bytecodeHash });
}

/** Same as Forwarder.feeOn: floor(amount * feeBps / 10000). */
export function forwarderFeeOn(amount: bigint, feeBps: number): bigint {
  if (amount < 0n) throw new RangeError('amount cannot be negative');
  return (amount / BPS) * BigInt(feeBps) + ((amount % BPS) * BigInt(feeBps)) / BPS;
}

/** Fee one flush of `amount` takes on the invoice token, given what earlier flushes took (same as Forwarder.flush). */
export function forwarderFlushFee(amount: bigint, feeBps: number, feeCap: bigint, feeTaken = 0n): bigint {
  const fee = forwarderFeeOn(amount, feeBps);
  const room = feeCap - feeTaken;
  if (room < 0n) throw new RangeError('feeTaken above feeCap');
  return fee > room ? room : fee;
}

/** Calldata for ForwarderFactory.deployAndFlush (deploys if needed, then flushes each asset; zero address = native). */
export function deployAndFlushData(salt: Hex, p: ForwarderParams, assets: readonly string[]): Hex {
  checkForwarderParams(p);
  if (assets.length === 0) throw new Error('at least one asset to flush');
  return encodeFunctionData({
    abi: FORWARDER_FACTORY_ABI,
    functionName: 'deployAndFlush',
    args: [salt, getAddress(p.merchant), getAddress(p.feeRecipient), getAddress(p.token), p.feeBps, p.feeCap, assets.map((a) => getAddress(a))],
  });
}

export interface FlushedEvent {
  asset: Address;
  toMerchant: bigint;
  fee: bigint;
}

/** Flushed events emitted by `forwarder` in a receipt's logs (what actually moved). */
export function decodeFlushed(logs: readonly { address: string; topics: readonly string[]; data: string }[], forwarder: string): FlushedEvent[] {
  const out: FlushedEvent[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== forwarder.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: FORWARDER_ABI, eventName: 'Flushed', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
      const a = ev.args as unknown as { asset: Address; toMerchant: bigint; fee: bigint };
      out.push({ asset: getAddress(a.asset), toMerchant: a.toMerchant, fee: a.fee });
    } catch {
      // not a Forwarder event
    }
  }
  return out;
}
