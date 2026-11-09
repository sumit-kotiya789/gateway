import { useMemo, useState } from 'react';
import { SIGNUP, href } from '../router';
import { Faq, SectionHead, type Qa } from '../ui/bits';
import { IArrow, ICheck, IFlask, IPercent, ISend, IX } from '../ui/icons';
import { CtaBand, PageHero } from './How';

// Display-only fee maths in integer micro-units (6 dp), the same rule as the ledger: fee = floor(amount × bps / 10000).
const SCALE = 1_000_000n;
function parseAmount(s: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(s.trim().replace(/,/g, ''));
  if (!m) return null;
  const whole = BigInt(m[1] ?? '0');
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
  return whole * SCALE + frac;
}
function fmt(v: bigint, minDp = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (a % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < minDp) frac = frac.padEnd(minDp, '0');
  return `${neg ? '−' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const BPS = 100n;

function Calculator() {
  const [amount, setAmount] = useState('250');
  const [count, setCount] = useState('1000');
  const r = useMemo(() => {
    const a = parseAmount(amount);
    const n = /^\d{1,7}$/.test(count.trim()) ? BigInt(count.trim()) : null;
    if (a === null || n === null) return null;
    const fee = (a * BPS) / 10_000n;
    return { a, fee, net: a - fee, vol: a * n, fees: fee * n, netAll: (a - fee) * n };
  }, [amount, count]);
  return (
    <div className="calc reveal">
      <div className="calc-in">
        <h3>Fee calculator</h3>
        <p className="muted">Deposits and invoice payments, 1%. Exact, in USDT.</p>
        <label className="field">
          <span>Deposit amount</span>
          <div className="field-box">
            <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); }} aria-invalid={parseAmount(amount) === null} />
            <span className="unit">USDT</span>
          </div>
        </label>
        <div className="presets">
          {['10', '100', '250', '1000', '25000'].map((p) => (
            <button key={p} type="button" className={amount === p ? 'on' : ''} onClick={() => { setAmount(p); }}>{fmt(BigInt(p) * SCALE, 0)}</button>
          ))}
        </div>
        <label className="field">
          <span>Deposits per month</span>
          <div className="field-box">
            <input inputMode="numeric" value={count} onChange={(e) => { setCount(e.target.value); }} aria-invalid={!/^\d{1,7}$/.test(count.trim())} />
            <span className="unit">×</span>
          </div>
        </label>
      </div>
      <div className="calc-out" aria-live="polite">
        {r ? (
          <>
            <div className="calc-row"><span>Your user sends</span><b className="mono">{fmt(r.a)} USDT</b></div>
            <div className="calc-row fee"><span>Fee (1%)</span><b className="mono">−{fmt(r.fee)} USDT</b></div>
            <div className="calc-row total"><span>You receive</span><b className="mono">{fmt(r.net)} USDT</b></div>
            <div className="calc-sep" />
            <div className="calc-grid">
              <div><span>Monthly volume</span><b className="mono">{fmt(r.vol, 0)}</b></div>
              <div><span>Monthly fees</span><b className="mono">{fmt(r.fees, 0)}</b></div>
              <div><span>You keep</span><b className="mono grad-text">{fmt(r.netAll, 0)}</b></div>
            </div>
            <p className="faint small">No monthly fee on top. Custody off: the fee is split on-chain or from your prepaid fee balance; custody on: deducted at settlement.</p>
          </>
        ) : (
          <p className="muted">Enter an amount with up to 6 decimals and a whole number of deposits.</p>
        )}
      </div>
    </div>
  );
}

const INCLUDED = [
  'Permanent deposit address per user',
  'Invoices, hosted checkout and widget',
  'Payment links (no code)',
  'Signed webhooks with retries and resend',
  'Node.js SDK and OpenAPI 3.1 spec',
  'Double-entry ledger and hourly reconciliation',
  'Team roles, 2FA and audit log',
  'CSV exports for accounting',
  'Marketplace sub-merchants',
  'WooCommerce plugin',
  'Test mode on BSC testnet',
  'Three custody modes',
];

const BUILD: [string, string, string][] = [
  ['A unique address per user', 'HD wallet, derivation, gap limits', 'One API call'],
  ['Detecting deposits', 'Nodes or RPCs, scanners, cursors', 'Included'],
  ['Confirmations and reorgs', 'Your own finality logic', 'Tiered, final, reorg-safe'],
  ['Notifying your app', 'Queues, retries, signatures', 'Signed webhooks, 12 attempts'],
  ['Accounting', 'A ledger you have to trust', 'Double-entry, reconciled hourly'],
  ['Paying users out', 'Hot wallet, key custody, limits', 'POST /v1/payouts, within limits'],
  ['Time to first deposit', 'Weeks', 'An afternoon'],
];

const FAQ: Qa[] = [
  { q: 'Is there a monthly or setup fee?', a: 'No. You pay 1% of what you receive, and nothing when nothing comes in. Test mode is free.' },
  { q: 'Are overpayments charged?', a: 'No. The fee is calculated on the smaller of what arrived and the invoice amount. For deposits to a permanent address, the fee is on the amount sent.' },
  { q: 'How much is the payout fee?', a: 'A flat fee per payout to a user (custody on), charged on top of the amount and covering the network fee. It is agreed with your account and shown on every payout as `fee`.' },
  { q: 'Do withdrawals to my own wallet cost anything?', a: 'No. Withdrawals of your balance to your payout address are free when custody is on; network fees are on us.' },
  { q: 'How is the fee collected without custody?', a: 'With a wallet address, the forwarder contract splits the fee off on-chain. With an xpub, it comes from a prepaid fee balance that you top up; the dashboard shows when it runs low.' },
  { q: 'Is volume pricing available?', a: 'Yes. Fees are set per account, so higher volumes can get a lower rate. Fees always apply to new invoices only, and every invoice shows the fee it was created with.' },
];

export function Pricing() {
  return (
    <>
      <PageHero
        page="pricing"
        eyebrow="Pricing"
        title={<>Simple pricing. <span className="grad-text">Pay when you get paid.</span></>}
        lead="No monthly fee, no setup fee, no minimums. A small fee on what you receive; test mode is free forever."
      />
      <section className="section tight">
        <div className="container">
          <div className="prices">
            <article className="card price reveal d1">
              <span className="ico-wrap teal"><IFlask /></span>
              <h3>Test mode</h3>
              <div className="price-big">Free</div>
              <p>Everything, on BSC testnet with a test token. Build and test end to end.</p>
              <ul className="checks">
                <li><ICheck /><span>All APIs and webhooks</span></li>
                <li><ICheck /><span>Unlimited test invoices and deposits</span></li>
                <li><ICheck /><span>Testnet token for payments</span></li>
              </ul>
              <a className="btn ghost" href={SIGNUP}>Start testing</a>
            </article>
            <article className="card price featured reveal d2">
              <div className="featured-glow" aria-hidden="true" />
              <span className="ribbon">Live</span>
              <span className="ico-wrap"><IPercent /></span>
              <h3>Deposits &amp; invoices</h3>
              <div className="price-big"><span className="grad-text">1%</span><small> per payment</small></div>
              <p>Of each deposit or invoice payment. Overpayments are not charged. No monthly fee.</p>
              <ul className="checks">
                <li><ICheck /><span>Every feature included</span></li>
                <li><ICheck /><span>Custody on or off</span></li>
                <li><ICheck /><span>Fee shown on every invoice</span></li>
              </ul>
              <a className="btn primary" href={SIGNUP}>Create an account <IArrow /></a>
            </article>
            <article className="card price reveal d3">
              <span className="ico-wrap violet"><ISend /></span>
              <h3>Payouts &amp; withdrawals</h3>
              <div className="price-big">Flat<small> per payout</small></div>
              <p>Payouts to your users carry a flat fee that covers the network fee. Withdrawals to your own wallet are free.</p>
              <ul className="checks">
                <li><ICheck /><span>Custody on</span></li>
                <li><ICheck /><span>Within your own limits</span></li>
                <li><ICheck /><span>Free withdrawals to your wallet</span></li>
              </ul>
              <a className="btn ghost" href={href('docs', 'payouts')}>How payouts work</a>
            </article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionHead eyebrow="Calculator" title="See exactly what you keep." lead="The same rounding the ledger uses: the fee is rounded down, never up." />
          <Calculator />
        </div>
      </section>

      <section className="section alt">
        <div className="container">
          <SectionHead eyebrow="Included" title="Every feature, on every account." lead="There are no tiers to unlock. If it is in the product, you have it." />
          <div className="included reveal">
            {INCLUDED.map((i) => (
              <div key={i} className="inc"><ICheck /><span>{i}</span></div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionHead eyebrow="Build vs. buy" title="What 1% replaces." lead="A wallet backend is not a weekend project. This is the work you skip." />
          <div className="table-wrap reveal compare">
            <table className="t">
              <thead>
                <tr>
                  <th />
                  <th><span className="th-mode"><IX /> Build it yourself</span></th>
                  <th className="hl"><span className="th-mode"><ICheck /> With Gateway</span></th>
                </tr>
              </thead>
              <tbody>
                {BUILD.map(([k, a, b]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="muted">{a}</td>
                    <td className="hl">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section alt">
        <div className="container narrow">
          <SectionHead center eyebrow="Pricing FAQ" title="The fine print, in plain words." />
          <Faq items={FAQ} />
        </div>
      </section>
      <CtaBand />
    </>
  );
}
