// Chain-agnostic contracts. Core and server code depend on these only; chain specifics live in @gw/chains adapters.

export const CHAIN_FAMILIES = ['evm', 'tron', 'solana'] as const;
export type ChainFamily = (typeof CHAIN_FAMILIES)[number];

export interface ChainConfig {
  id: string; // "bsc", "bsc-testnet", "eth", ...
  family: ChainFamily;
  name: string;
  evmChainId: number | null;
  rpcUrls: readonly string[];
  explorerUrl: string | null;
  nativeSymbol: string;
  nativeDecimals: number;
  blockTimeMs: number;
  defaultConfirmations: number;
  reorgDepth: number;
  /** 'tag' = chain exposes a `finalized` block tag (e.g. BSC fast finality); 'confirmations' = count only. */
  finality: 'tag' | 'confirmations';
  testnet: boolean;
  enabled: boolean;
}

export interface ConfirmationTier {
  /** Inclusive lower bound, token minor units. */
  minAmount: bigint;
  confirmations: number;
}

export interface TokenConfig {
  id: string; // "bsc:usdt"
  chainId: string;
  symbol: string;
  name: string;
  contractAddress: string;
  decimals: number;
  minConfirmations: number;
  confirmationTiers: readonly ConfirmationTier[];
  /** Transfers below this (minor units) are ignored: dust / address-poisoning defense. */
  minAmount: bigint;
  enabled: boolean;
}

export interface BlockInfo {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
}

/** One token transfer event, as emitted on-chain. */
export interface Transfer {
  chainId: string;
  tokenAddress: string;
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
}

export interface Receipt {
  txHash: string;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: string;
  /** Every Transfer-shaped log in the receipt, any emitter. Callers must filter by token contract. */
  transfers: readonly Transfer[];
}

export interface TxRequest {
  from: string;
  to: string;
  data?: string;
  value?: bigint;
}

export interface FeeEstimate {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** gasLimit * maxFeePerGas, native minor units: the worst-case fee. */
  maxTotal: bigint;
}

export interface ChainAdapter {
  readonly chainId: string;
  readonly family: ChainFamily;
  /** Network identity reported by the RPC (EVM: chain id). Checked against config before use. */
  getNetworkId(): Promise<string>;
  getLatestBlock(): Promise<bigint>;
  /** Highest finalized block, or null when the chain/RPC has no finality tag. */
  getFinalizedBlock(): Promise<bigint | null>;
  getBlock(n: bigint): Promise<BlockInfo>;
  getTokenTransfers(token: TokenConfig, from: bigint, to: bigint): Promise<Transfer[]>;
  getBalance(address: string, token: TokenConfig | null): Promise<bigint>;
  getTransactionReceipt(hash: string): Promise<Receipt | null>;
  readTokenDecimals(token: TokenConfig): Promise<number>;
  estimateFee(tx: TxRequest): Promise<FeeEstimate>;
  broadcast(signedTx: string): Promise<string>;
  isValidAddress(addr: string): boolean;
  normalizeAddress(addr: string): string;
}

/** Public derivation only. Private-key derivation exists solely inside the signer (custodial, M7). */
export interface AddressDeriver {
  readonly family: ChainFamily;
  /** Throws on anything that is not an account-level extended PUBLIC key. */
  validateXpub(xpub: string): void;
  /** Encoding-independent key id (xpub and tpub of one key collide). Used for global uniqueness. */
  keyFingerprint(xpub: string): string;
  deriveFromXpub(xpub: string, index: number): { address: string; path: string };
}

export const CUSTODY_MODES = ['custodial', 'non_custodial_xpub', 'non_custodial_forwarder'] as const;
export type CustodyMode = (typeof CUSTODY_MODES)[number];

export interface AllocationRequest {
  merchantId: string;
  livemode: boolean;
  chain: ChainConfig;
}

export interface DepositAddress {
  id: string;
  address: string;
  chainId: string;
  source: 'platform' | 'merchant_xpub';
  derivationIndex: number;
  derivationPath: string;
}

/** Custody behavior per merchant mode. `Tx` is the caller's DB transaction type. */
export interface CustodyStrategy<Tx> {
  readonly mode: CustodyMode;
  allocateDepositAddress(tx: Tx, req: AllocationRequest): Promise<DepositAddress>;
  supportsWithdrawals(): boolean;
}
