// How networks and tokens are named and shown to people (D-112): official names, native coin tickers, the tag payers
// match in their wallet or exchange (BEP-20, ERC-20, ...) and the official logos. Display only: what gets credited is
// decided by the chain/token registry in the database, never by this file.
import { LOGOS, type LogoKey } from './logos.js';

export { LOGOS, type LogoKey } from './logos.js';

export interface Network {
  /** Registry chain id. */
  id: string;
  /** Official network name, as wallets and exchanges show it. */
  name: string;
  /** Ticker of the native coin that pays the network fee. */
  native: string;
  /** Token standard wallets and exchanges name for this network, when there is a distinct one. */
  standard: 'BEP-20' | 'ERC-20' | null;
  /** Short tag payers match when they pick a network to send on: the token standard, or the network's own name. */
  tag: string;
  logo: LogoKey;
  testnet: boolean;
}

export const NETWORKS: Readonly<Record<string, Network>> = {
  bsc: { id: 'bsc', name: 'BNB Smart Chain', native: 'BNB', standard: 'BEP-20', tag: 'BEP-20', logo: 'BNB', testnet: false },
  eth: { id: 'eth', name: 'Ethereum', native: 'ETH', standard: 'ERC-20', tag: 'ERC-20', logo: 'ETH', testnet: false },
  // Polygon tokens are ERC-20 contracts, but "ERC-20" reads as Ethereum to payers: exchanges list the network as Polygon.
  polygon: { id: 'polygon', name: 'Polygon PoS', native: 'POL', standard: null, tag: 'Polygon', logo: 'POL', testnet: false },
  'bsc-testnet': { id: 'bsc-testnet', name: 'BNB Smart Chain Testnet', native: 'tBNB', standard: 'BEP-20', tag: 'BEP-20 testnet', logo: 'BNB', testnet: true },
};

/** The official token mark, for the real contracts only: a mock that shares the symbol never gets Tether's logo. */
const TOKEN_LOGOS: Readonly<Record<string, LogoKey>> = { 'bsc:usdt': 'USDT', 'eth:usdt': 'USDT', 'polygon:usdt': 'USDT' };

/** Native coins, by ticker. */
const COIN_LOGOS: Readonly<Record<string, LogoKey>> = { BNB: 'BNB', ETH: 'ETH', POL: 'POL' };

/** "eth:usdt" -> "eth". A chain id passes through unchanged. */
export function chainOf(tokenOrChainId: string): string {
  const i = tokenOrChainId.indexOf(':');
  return i < 0 ? tokenOrChainId : tokenOrChainId.slice(0, i);
}

/** The network of a chain id or token id ("bsc" or "bsc:usdt"); undefined for one this file does not know. */
export function networkOf(tokenOrChainId: string): Network | undefined {
  return Object.hasOwn(NETWORKS, chainOf(tokenOrChainId)) ? NETWORKS[chainOf(tokenOrChainId)] : undefined;
}

/** Logo of a registry token id ("eth:usdt") or a native coin ticker ("ETH"); null when there is no official one. */
export function tokenLogo(tokenIdOrCoin: string): LogoKey | null {
  if (Object.hasOwn(TOKEN_LOGOS, tokenIdOrCoin)) return TOKEN_LOGOS[tokenIdOrCoin] ?? null;
  if (Object.hasOwn(COIN_LOGOS, tokenIdOrCoin)) return COIN_LOGOS[tokenIdOrCoin] ?? null;
  return null;
}

const uris = new Map<LogoKey, string>();

/** A logo as a data: URI for an <img> (every CSP here allows `img-src data:`; inline SVG ids could collide). */
export function logoUri(key: LogoKey): string {
  let u = uris.get(key);
  if (!u) {
    u = `data:image/svg+xml,${encodeURIComponent(LOGOS[key])}`;
    uris.set(key, u);
  }
  return u;
}

/** "USDT · ERC-20" style label of a token: its symbol and the tag of its network (just the symbol when unknown). */
export function tokenLabel(tokenId: string, symbol: string): string {
  const n = networkOf(tokenId);
  return n ? `${symbol} · ${n.tag}` : symbol;
}
