import { describe, expect, it } from 'vitest';
import { checkoutPage, type Loaded } from '../../src/modules/checkout/checkout.routes.js';
import { pageHtml } from '../../src/modules/checkout/html.js';
import { MODEL_OF, TONE_OF } from '../../src/modules/checkout/scene.js';
import { INVOICE_STATUSES } from '@gw/core';

const E = 10n ** 16n;
const BSC = {
  token: { id: 'bsc:usdt', decimals: 18, symbol: 'USDT', contractAddress: '0x55d398326f99059fF775485246999027B3197955' },
  chain: { id: 'bsc', name: 'BNB Smart Chain', evmChainId: 56, family: 'evm' },
};
const page = async (status: string, received = 0n, merchantName = 'shop', on: { token: object; chain: object } = BSC) => {
  const r = {
    inv: {
      id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
      depositAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      amountExpected: E,
      amountReceived: received,
      status,
      expiresAt: new Date(Date.now() + 600_000),
      successUrl: 'https://shop.example/thanks',
      cancelUrl: 'https://shop.example/cart',
      livemode: true,
    },
    ...on,
    merchantName,
    widgetOrigins: [],
  } as unknown as Loaded;
  return pageHtml(await checkoutPage(r, undefined), 'n');
};

describe('hosted checkout scene (D-108)', () => {
  it('every invoice status has a model', () => {
    for (const s of INVOICE_STATUSES) expect(MODEL_OF[s]).toBeTruthy();
    expect(Object.keys(TONE_OF).every((s) => (INVOICE_STATUSES as readonly string[]).includes(s))).toBe(true);
  });

  it('waiting: pay area and the coin model; the thank-you screen stays hidden', async () => {
    const b = await page('pending');
    expect(b).toContain('data-model="coin" data-tone="wait"');
    expect(b).toContain('Waiting for payment');
    expect(b).toMatch(/<div id="paybody">/);
    expect(b).toMatch(/<section id="done" class="done" hidden/);
    expect(b).toContain('stroke-dasharray="0 100"');
  });

  it('partial payment fills the ring; expired keeps the do-not-send advice', async () => {
    expect(await page('underpaid', (E * 45n) / 100n)).toContain('stroke-dasharray="45 100"');
    const x = await page('expired');
    expect(x).toContain('data-model="glass" data-tone="bad"');
    expect(x).toContain('Do not send funds');
  });

  it('official token and network marks with the network named in the warning (D-112)', async () => {
    const bsc = await page('pending');
    expect(bsc).toMatch(/<span class="ticon"><img src="data:image\/svg\+xml,%3Csvg[^"]*" alt="" \/><img class="tbadge" src="data:image\/svg\+xml,/);
    expect(bsc).toContain('<span>BNB Smart Chain</span><small>BEP-20</small>');
    expect(bsc).toContain('Send only USDT (BEP-20) on BNB Smart Chain.');
    const eth = await page('pending', 0n, 'shop', {
      token: { id: 'eth:usdt', decimals: 6, symbol: 'USDT', contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
      chain: { id: 'eth', name: 'Ethereum', evmChainId: 1, family: 'evm' },
    });
    expect(eth).toContain('Send only USDT (ERC-20) on Ethereum.');
    const pol = await page('pending', 0n, 'shop', {
      token: { id: 'polygon:usdt', decimals: 6, symbol: 'USDT', contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
      chain: { id: 'polygon', name: 'Polygon PoS', evmChainId: 137, family: 'evm' },
    });
    expect(pol).toContain('Send only USDT on Polygon PoS.');
    expect(pol).toContain('<span>Polygon PoS</span></span>');
    // A chain or token without an official mark (local dev chain, mocks): names only, no image.
    const local = await page('pending', 0n, 'shop', {
      token: { id: 'evm-local:usdt', decimals: 18, symbol: 'USDT', contractAddress: '0x0000000000000000000000000000000000000002' },
      chain: { id: 'evm-local', name: 'Local Anvil', evmChainId: 31337, family: 'evm' },
    });
    expect(local).not.toContain('class="ticon"');
    expect(local).toContain('Send only USDT on Local Anvil.');
  });

  it('settled: the thank-you screen with a receipt, pay area hidden, merchant name escaped, no inline styles', async () => {
    const b = await page('settled', E, '<b>shop</b>');
    expect(b).toMatch(/<div id="paybody" hidden>/);
    expect(b).toMatch(/<section id="done" class="done" aria-live/);
    expect(b).toContain('Thank you!');
    expect(b).toContain('Your payment of 0.01 USDT to &lt;b&gt;shop&lt;/b&gt; is complete.');
    expect(b).toContain('0192f3a4…abcd');
    expect(b).not.toContain('<b>shop</b>');
    expect(b).not.toMatch(/style="/); // the CSP allows no inline styles
    expect(b).toMatch(/<p class="cancel" id="cancel" hidden>/);
  });
});
