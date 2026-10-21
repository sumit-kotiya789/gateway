// Test helpers for a local Anvil chain. Uses Anvil's published dev keys; never use these anywhere else.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChainConfig, TokenConfig } from '@gw/core';
import { createPublicClient, createWalletClient, getAddress, http, type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
// Test files run in parallel against one Anvil node: each file must sign with its OWN account, or concurrent
// transactions collide on nonces. Chain-package tests use index 9; server tests pass their own index.
export const payer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 9 });
export const anvilAccount = (addressIndex: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex });

type Artifact = { abi: Abi; bytecode: Hex };
const mocks = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/mocks.json'), 'utf8')) as Record<
  'MockERC20' | 'FeeOnTransferERC20' | 'FakeTransferEmitter',
  Artifact
>;
export const MOCK_ABI = mocks.MockERC20.abi;
export const FAKE_ABI = mocks.FakeTransferEmitter.abi;

export function anvilClients(url: string, account = payer) {
  const transport = http(url);
  return {
    pub: createPublicClient({ chain: foundry, transport }),
    wallet: createWalletClient({ chain: foundry, transport, account }),
  };
}

export async function deploy(url: string, name: keyof typeof mocks, args: readonly unknown[] = [], account = payer): Promise<Address> {
  const { pub, wallet } = anvilClients(url, account);
  const hash = await wallet.deployContract({ abi: mocks[name].abi, bytecode: mocks[name].bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error(`deploy of ${name} failed`);
  return getAddress(r.contractAddress);
}

export async function mineBlocks(url: string, n: number): Promise<void> {
  const { pub } = anvilClients(url);
  await pub.request({ method: 'anvil_mine' as never, params: [`0x${n.toString(16)}`] as never });
}

export function localChain(rpcUrl: string, over: Partial<ChainConfig> = {}): ChainConfig {
  return {
    id: 'evm-local',
    family: 'evm',
    name: 'Local Anvil',
    evmChainId: 31337,
    rpcUrls: [rpcUrl],
    explorerUrl: null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockTimeMs: 1000,
    defaultConfirmations: 2,
    reorgDepth: 16,
    finality: 'tag',
    testnet: true,
    enabled: true,
    ...over,
  };
}

export function tokenConfig(address: string, over: Partial<TokenConfig> = {}): TokenConfig {
  return {
    id: 'evm-local:usdt',
    chainId: 'evm-local',
    symbol: 'USDT',
    name: 'Mock USDT',
    contractAddress: address,
    decimals: 18,
    minConfirmations: 2,
    confirmationTiers: [],
    minAmount: 10n ** 16n,
    enabled: true,
    ...over,
  };
}
