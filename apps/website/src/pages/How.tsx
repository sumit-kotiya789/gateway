import { useState, type ReactNode } from 'react';
import { SIGNUP, href } from '../router';
import { Callout, Rich, SectionHead } from '../ui/bits';
import { useInView } from '../ui/effects';
import {
  IActivity, IArrow, IBranch, ICheck, IClock, ICpu, IDatabase, IEye, IGauge, IKey, ILayers, ILock, IRefresh, IScale, ISend,
  IServer, IShield, IWallet, IWebhook, IX, IZap,
} from '../ui/icons';

export function How() {
  return (
    <>
      <PageHero
        eyebrow="How it works"
        title={<>From a user's wallet <span className="grad-text">to your database.</span></>}
        lead="What happens to every deposit, invoice and payout, step by step, and where you plug in. Nothing here is a black box: every state is an object you can fetch."
        chips={[
          ['lifecycle', 'Deposit lifecycle'],
          ['statuses', 'Statuses'],
          ['confirmations', 'Confirmations'],
          ['custody', 'Custody modes'],
          ['payouts', 'Payouts'],
          ['delivery', 'Webhook delivery'],
          ['architecture', 'Architecture'],
        ]}
        page="how"
      />
      <Lifecycle />
      <Statuses />
      <Confirmations />
      <CustodyTable />
      <Payouts />
      <Delivery />
      <Architecture />
      <CtaBand />
    </>
  );
}

export function PageHero(props: { eyebrow: string; title: ReactNode; lead: string; chips?: [string, string][]; page: 'how' | 'security' | 'pricing'; aside?: ReactNode }) {
  return (
    <section className={`page-hero ${props.aside ? 'with-aside' : ''}`}>
      <div className="page-hero-bg" aria-hidden="true" />
      <div className="container page-hero-inner">
        <div className="page-hero-copy">
          <span className="eyebrow hero-pill">{props.eyebrow}</span>
          <h1>{props.title}</h1>
          <p className="lead">{props.lead}</p>
          {props.chips && (
            <nav className="chips" aria-label="On this page">
              {props.chips.map(([id, label]) => (
                <a key={id} className="chip" href={href(props.page, id)}>{label}</a>
              ))}
            </nav>
          )}
        </div>
        {props.aside}
      </div>
    </section>
  );
}

/* ---------------- Lifecycle ---------------- */

const STEPS: { icon: ReactNode; title: string; who: 'you' | 'gateway' | 'user'; body: string; code?: string }[] = [
  { icon: <IKey />, who: 'you', title: 'Ask for the user’s address', body: 'Your backend calls `POST /v1/deposit-accounts` with your own user id as `customer_ref` and the token. The first call creates the account (201); every later call returns the same address (200).', code: 'POST /v1/deposit-accounts' },
  { icon: <IWallet />, who: 'user', title: 'The user sends USDT', body: 'Any amount, any number of times, from any wallet or exchange that supports BEP-20. Show the network next to the address: BNB Smart Chain.' },
  { icon: <IActivity />, who: 'gateway', title: 'The transfer is detected', body: 'The watcher scans each block for `Transfer` logs of the exact token contract to your addresses. A missed block is rescanned from the cursor: an outage delays crediting, it never loses a payment.' },
  { icon: <IRefresh />, who: 'gateway', title: 'Confirmations and finality', body: 'The deposit waits until it is deep enough (15 blocks for USDT, more for large amounts) and at or below the chain’s finalized block. A reorg moves it back to `pending` and you get `invoice.pending`.' },
  { icon: <IDatabase />, who: 'gateway', title: 'Booked in one transaction', body: 'Invoice status, payment, ledger journal and the outgoing event are written in a single database transaction: they can never disagree. Database triggers reject unbalanced journals.' },
  { icon: <IWebhook />, who: 'gateway', title: 'Signed webhook', body: 'Each status change is POSTed to your endpoints: `invoice.detected`, `invoice.confirming`, `invoice.paid`, `invoice.settled`. Signed with HMAC-SHA256, retried until you answer 2xx.', code: 'gateway-signature: t=…,v1=…' },
  { icon: <IZap />, who: 'you', title: 'Credit the user, once', body: 'On `invoice.settled` with `kind: "deposit"`, credit `amount_received` to `customer_ref`, keyed by the invoice id so a redelivery never credits twice.' },
];

function Lifecycle() {
  return (
    <section className="section" id="lifecycle">
      <div className="container">
        <div className="split-sticky">
          <div className="sticky-col">
            <SectionHead eyebrow="01 · Deposit lifecycle" title="Seven steps. You write two of them." lead="Everything in green happens on our side, the same way in test mode and live." />
            <div className="legend reveal">
              <span><i className="lg-you" /> Your backend</span>
              <span><i className="lg-user" /> Your user</span>
              <span><i className="lg-gw" /> Gateway</span>
            </div>
          </div>
          <ol className="timeline">
            {STEPS.map((s, i) => (
              <li key={s.title} className={`tl-item who-${s.who} reveal`}>
                <div className="tl-node">{s.icon}</div>
                <div className="tl-body">
                  <div className="tl-top">
                    <span className="tl-n mono">{String(i + 1).padStart(2, '0')}</span>
                    <span className={`badge ${s.who === 'gateway' ? 'green' : s.who === 'you' ? 'blue' : 'amber'}`}>{s.who === 'gateway' ? 'Gateway' : s.who === 'you' ? 'You' : 'User'}</span>
                  </div>
                  <h3>{s.title}</h3>
                  <p><Rich text={s.body} /></p>
                  {s.code && <code className="tl-code">{s.code}</code>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Statuses ---------------- */

interface St { id: string; group: 'progress' | 'paid' | 'exception' | 'final'; text: string; from: string[]; to: string[]; fulfil: boolean; final: boolean }
const STATUSES: St[] = [
  { id: 'pending', group: 'progress', text: 'Waiting for payment. The address is shown to the customer; a deposit account’s address is always waiting.', from: ['created', 'detected (reorg)', 'confirming (reorg)'], to: ['detected', 'expired', 'cancelled'], fulfil: false, final: false },
  { id: 'detected', group: 'progress', text: 'A transfer was seen in a block but is not deep enough yet. Never fulfil here: it can still be reorged away.', from: ['pending', 'underpaid (top-up)'], to: ['confirming', 'pending'], fulfil: false, final: false },
  { id: 'confirming', group: 'progress', text: 'Waiting for the required confirmations and finality. The invoice shows how many confirmations each payment needs.', from: ['detected'], to: ['paid', 'underpaid', 'overpaid', 'held', 'pending'], fulfil: false, final: false },
  { id: 'paid', group: 'paid', text: 'Confirmed payments cover the amount. Safe to fulfil the order. Settlement follows (fee booked, funds swept when custody is on).', from: ['confirming', 'underpaid (accepted)', 'held (released)', 'late_payment (resolved)'], to: ['settled'], fulfil: true, final: false },
  { id: 'overpaid', group: 'paid', text: 'More than the amount arrived. Fulfil the order; the fee is charged on the invoice amount, not the overpayment.', from: ['confirming'], to: ['settled'], fulfil: true, final: false },
  { id: 'settled', group: 'final', text: 'Final. Custody off: the platform fee was charged. Custody on: the deposit address was swept and the amount (minus the fee) is in your available balance. Credit deposits here.', from: ['paid', 'overpaid'], to: [], fulfil: true, final: true },
  { id: 'underpaid', group: 'exception', text: 'Less than the amount arrived. The customer can send the rest before the deadline; you can also accept it as paid.', from: ['confirming'], to: ['detected', 'paid', 'partially_paid'], fulfil: false, final: false },
  { id: 'partially_paid', group: 'final', text: 'Custody on only, final. Still underpaid at the deadline: what arrived is credited minus the fee on that amount. The order was not paid in full: refund or ask for the rest.', from: ['underpaid'], to: [], fulfil: false, final: true },
  { id: 'held', group: 'exception', text: 'Paid, but held for the platform’s risk review. Do not ship. It becomes paid when released, or failed if rejected.', from: ['confirming'], to: ['paid', 'failed'], fulfil: false, final: false },
  { id: 'expired', group: 'exception', text: 'The deadline passed without a payment (expires_in: 300 s to 24 h, default 30 min).', from: ['pending'], to: ['late_payment'], fulfil: false, final: false },
  { id: 'cancelled', group: 'exception', text: 'You cancelled the invoice while it was pending.', from: ['pending'], to: ['late_payment'], fulfil: false, final: false },
  { id: 'late_payment', group: 'exception', text: 'A payment mined after the deadline. Never fulfilled automatically; it can be resolved to paid by a manual decision.', from: ['expired', 'cancelled'], to: ['paid'], fulfil: false, final: false },
  { id: 'failed', group: 'final', text: 'Final. Rejected after a risk review, or the invoice could not be created. Refund the customer if funds arrived.', from: ['created', 'held'], to: [], fulfil: false, final: true },
];
const GROUPS: { id: St['group']; label: string }[] = [
  { id: 'progress', label: 'In progress' },
  { id: 'paid', label: 'Paid' },
  { id: 'exception', label: 'Needs attention' },
  { id: 'final', label: 'Final' },
];

function Statuses() {
  const [sel, setSel] = useState('confirming');
  const cur = STATUSES.find((s) => s.id === sel) ?? STATUSES[0];
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  return (
    <section className="section alt" id="statuses">
      <div className="container">
        <SectionHead
          eyebrow="02 · Statuses"
          title={<>Every state, <span className="grad-text">explained.</span></>}
          lead="Invoices and deposits share one state machine, enforced by the database: an illegal transition is refused, even by our own code. Pick a status."
        />
        <div ref={ref} className="happy reveal" data-run={seen} aria-hidden="true">
          {['pending', 'detected', 'confirming', 'paid', 'settled'].map((s, i) => (
            <div key={s} className="happy-node">
              <span className={`happy-dot d${String(i)}`} />
              <span className="mono">{s}</span>
            </div>
          ))}
          <div className="happy-line"><span /></div>
        </div>
        <div className="status-explorer reveal">
          <div className="status-groups">
            {GROUPS.map((g) => (
              <div key={g.id} className="status-group">
                <h4>{g.label}</h4>
                <div className="status-chips">
                  {STATUSES.filter((s) => s.group === g.id).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`status-chip g-${s.group} ${sel === s.id ? 'on' : ''}`}
                      aria-pressed={sel === s.id}
                      onClick={() => {
                        setSel(s.id);
                      }}
                    >
                      {s.id}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {cur && (
            <div className="status-detail" key={cur.id}>
              <div className="sd-head">
                <code className="sd-name">{cur.id}</code>
                <span className="mono faint">invoice.{cur.id}</span>
              </div>
              <p>{cur.text}</p>
              <div className="sd-flags">
                <span className={cur.fulfil ? 'flag yes' : 'flag no'}>{cur.fulfil ? <ICheck /> : <IX />} Safe to fulfil</span>
                <span className={cur.final ? 'flag yes' : 'flag no'}>{cur.final ? <ICheck /> : <IX />} Final</span>
              </div>
              <div className="sd-edges">
                <div>
                  <h5>Comes from</h5>
                  <div className="row">{cur.from.length ? cur.from.map((f) => <span key={f} className="badge">{f}</span>) : <span className="faint">—</span>}</div>
                </div>
                <div>
                  <h5>Moves to</h5>
                  <div className="row">{cur.to.length ? cur.to.map((f) => <span key={f} className="badge green">{f}</span>) : <span className="faint">nothing: final</span>}</div>
                </div>
              </div>
            </div>
          )}
        </div>
        <Callout kind="warn">
          <strong>Fulfil on <code>paid</code> / <code>overpaid</code> (or <code>settled</code>), never on <code>detected</code> or <code>confirming</code>.</strong>{' '}
          Credit deposits on <code>invoice.settled</code>. Delivery order is not guaranteed: act on <code>data.status</code> or fetch the invoice.
        </Callout>
      </div>
    </section>
  );
}

/* ---------------- Confirmations ---------------- */

function Confirmations() {
  return (
    <section className="section" id="confirmations">
      <div className="container">
        <SectionHead eyebrow="03 · Confirmations & reorgs" title="Credited when it is final. Not a block sooner." lead="Chains reorganise. A payment is only money once it cannot be undone; until then it is a promise." />
        <div className="tiers reveal">
          <div className="tier">
            <span className="tier-amt mono">&lt; 10,000 USDT</span>
            <div className="tier-bar"><span className="t1" /></div>
            <span className="tier-n"><b>15</b> confirmations</span>
          </div>
          <div className="tier">
            <span className="tier-amt mono">≥ 10,000 USDT</span>
            <div className="tier-bar"><span className="t2" /></div>
            <span className="tier-n"><b>30</b> confirmations</span>
          </div>
          <div className="tier">
            <span className="tier-amt mono">≥ 100,000 USDT</span>
            <div className="tier-bar"><span className="t3" /></div>
            <span className="tier-n"><b>60</b> confirmations</span>
          </div>
        </div>
        <div className="grid g3 conf-cards">
          <article className="card spot reveal">
            <span className="ico-wrap"><ILayers /></span>
            <h3>Depth and finality</h3>
            <p>Credit only when <code>latest − tx block ≥ required</code>, and the tx block is at or below the chain's finalized block.</p>
          </article>
          <article className="card spot reveal d1">
            <span className="ico-wrap amber"><IBranch /></span>
            <h3>Reorg handling</h3>
            <p>A payment that disappears in a reorg returns the invoice to <code>pending</code> and fires <code>invoice.pending</code>. Confirmed is final in the database.</p>
          </article>
          <article className="card spot reveal d2">
            <span className="ico-wrap blue"><IEye /></span>
            <h3>Exact contract, agreeing providers</h3>
            <p>Only Transfer logs of the registered token contract count. On mainnet, two of three RPC providers must agree before a payment is confirmed.</p>
          </article>
          <article className="card spot reveal">
            <span className="ico-wrap teal"><IClock /></span>
            <h3>Mined before the deadline counts</h3>
            <p>A payment mined before the invoice deadline counts even if it is detected later. One mined after it becomes <code>late_payment</code>.</p>
          </article>
          <article className="card spot reveal d1">
            <span className="ico-wrap violet"><IScale /></span>
            <h3>Exact amounts</h3>
            <p>USDT on BSC has 18 decimals. Amounts are integers internally and decimal strings at the API: no float ever touches money.</p>
          </article>
          <article className="card spot reveal d2">
            <span className="ico-wrap red"><IShield /></span>
            <h3>Leader with a fence</h3>
            <p>One watcher per chain leads, a standby takes over within seconds, and a fencing epoch blocks a stale leader's writes.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Custody table ---------------- */

const CUSTODY_ROWS: [string, string, string, string][] = [
  ['Deposit address', 'A CREATE2 forwarder contract per address', 'Derived from your account xpub (0/i)', 'Platform HD wallet'],
  ['Keys on our servers', 'None', 'Your xpub only (public)', 'In an isolated signer only'],
  ['Who moves the funds', 'The contract, automatically', 'You, with your own wallet', 'We do: sweeps, withdrawals'],
  ['Merchant balance', 'No: funds are in your wallet', 'No: funds are in your wallet', 'Yes, in the ledger'],
  ['Fee collection', 'Split on-chain at forwarding', 'Prepaid fee balance', 'Deducted at settlement'],
  ['Payouts to users', 'From your own wallet', 'From your own wallet', 'By API, within your limits'],
  ['Best for', 'Most apps: simple, non-custodial', 'Hardware-wallet treasuries', 'Apps that pay users out'],
];

function CustodyTable() {
  return (
    <section className="section alt" id="custody">
      <div className="container">
        <SectionHead eyebrow="04 · Custody modes" title="Same API. You choose where the money goes." lead="Set per account in the dashboard. Each invoice snapshots its mode, and the mode locks after your first live invoice." />
        <div className="table-wrap reveal compare">
          <table className="t">
            <thead>
              <tr>
                <th />
                <th><span className="th-mode"><IWallet /> Wallet address</span><span className="th-sub">Custody off</span></th>
                <th><span className="th-mode"><IKey /> Extended public key</span><span className="th-sub">Custody off</span></th>
                <th className="hl"><span className="th-mode"><ILock /> Custody on</span><span className="th-sub">Managed</span></th>
              </tr>
            </thead>
            <tbody>
              {CUSTODY_ROWS.map(([k, a, b, c]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{a}</td>
                  <td>{b}</td>
                  <td className="hl">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Callout kind="info">
          With an xpub, never paste a seed phrase or a private key (<code>xprv</code>): the gateway detects and refuses them. Live xpubs also need an
          ownership proof, a signature by address <code>0/0</code>.
        </Callout>
      </div>
    </section>
  );
}

/* ---------------- Payouts ---------------- */

const PAYOUT_STEPS: { icon: ReactNode; title: string; text: string; tone: string }[] = [
  { icon: <IWallet />, title: 'You debit the user', text: 'In your own ledger, before calling us.', tone: 'blue' },
  { icon: <ISend />, title: 'POST /v1/payouts', text: 'With your request id as the Idempotency-Key.', tone: 'blue' },
  { icon: <IGauge />, title: 'Checks', text: 'One-time and daily limits, balance incl. the fee, destination.', tone: '' },
  { icon: <ICpu />, title: 'Signer re-checks', text: 'Against the ledger and your limits, then signs one transaction.', tone: '' },
  { icon: <IZap />, title: 'sent → confirmed', text: 'payout.sent with the tx hash, then payout.confirmed.', tone: '' },
];

function Payouts() {
  return (
    <section className="section" id="payouts">
      <div className="container">
        <SectionHead eyebrow="05 · Payouts to users" title="Pay users out with one call. Within your rules." lead="Custody on. Automatic below your limits, refused above them, with a clear reason you can show the user." />
        <div className="pflow reveal">
          {PAYOUT_STEPS.map((s, i) => (
            <div key={s.title} className="pstep">
              <span className={`ico-wrap ${s.tone}`}>{s.icon}</span>
              <span className="pstep-n mono">{String(i + 1)}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
        <div className="grid g2 payout-grid">
          <div className="card reveal">
            <h3>Refusals you can act on</h3>
            <div className="table-wrap flat">
              <table className="t">
                <tbody>
                  <tr><td><code>over_tx_limit</code></td><td>Above your one-time limit.</td></tr>
                  <tr><td><code>over_day_limit</code></td><td>Would exceed your 24-hour limit.</td></tr>
                  <tr><td><code>limits_required</code></td><td>Live payouts need both limits set.</td></tr>
                  <tr><td><code>insufficient_balance</code></td><td>Amount plus the payout fee exceeds your available balance.</td></tr>
                  <tr><td><code>bad_destination</code></td><td>A gateway or blocked address.</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="card reveal d1">
            <h3>Statuses</h3>
            <div className="pst">
              <span className="badge blue">approved</span><IArrow /><span className="badge amber">sent</span><IArrow /><span className="badge green">confirmed</span>
            </div>
            <p>Each change is a <code>payout.&lt;status&gt;</code> webhook. On <code>payout.failed</code> the hold is released: refund the user in your app.</p>
            <p className="muted small">Your own withdrawals to your payout address use the same pipeline with an approval step (<code>withdrawal.*</code> events).</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Webhook delivery ---------------- */

const RETRIES: [string, string][] = [
  ['now', '0'], ['+1 m', '1 m'], ['+5 m', '6 m'], ['+30 m', '36 m'], ['+2 h', '2 h 36 m'], ['+5 h', '7 h 36 m'],
  ['+10 h', '17.6 h'], ['+10 h', '27.6 h'], ['+10 h', '37.6 h'], ['+10 h', '47.6 h'], ['+10 h', '57.6 h'], ['+10 h', '67.6 h'],
];

function Delivery() {
  return (
    <section className="section alt" id="delivery">
      <div className="container">
        <SectionHead eyebrow="06 · Webhook delivery" title="At least once. Until you say 200." lead="Answer 2xx within 10 seconds, then do the work. Anything else, including redirects, is retried on this schedule." />
        <div className="retries reveal">
          {RETRIES.map(([d, c], i) => (
            <div key={`${d}-${String(i)}`} className="retry">
              <span className="retry-dot" />
              <span className="retry-n mono">#{String(i + 1)}</span>
              <span className="retry-d mono">{d}</span>
              <span className="retry-c mono">{c}</span>
            </div>
          ))}
        </div>
        <div className="grid g4 delivery-grid">
          <div className="mini reveal"><h4>Deduplicate</h4><p>Delivery is at-least-once: dedupe on the event <code>id</code> (also the <code>gateway-event-id</code> header).</p></div>
          <div className="mini reveal d1"><h4>Order is not guaranteed</h4><p>Act on <code>data.status</code>, or fetch the invoice for its current state.</p></div>
          <div className="mini reveal d2"><h4>Rotate without downtime</h4><p>During a rotation both secrets sign: the header carries several <code>v1</code> values.</p></div>
          <div className="mini reveal d3"><h4>Public endpoints only</h4><p>Private, loopback and link-local addresses are refused. Use a tunnel to test locally.</p></div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Architecture ---------------- */

function Architecture() {
  return (
    <section className="section" id="architecture">
      <div className="container">
        <SectionHead eyebrow="07 · Architecture" title="Four processes. One source of truth." lead="A modular monolith with one Postgres. Payments live on chain, so a component outage delays work; it never loses money." />
        <div className="arch reveal">
          <div className="arch-col">
            <div className="arch-box client"><IServer /><div><b>Your backend</b><span>secret key, webhooks</span></div></div>
            <div className="arch-box client"><IWallet /><div><b>Customer browser</b><span>hosted checkout, widget</span></div></div>
          </div>
          <div className="arch-arrow" aria-hidden="true"><i /></div>
          <div className="arch-col core">
            <div className="arch-box"><ILayers /><div><b>api</b><span>public, stateless, 2+ behind TLS</span></div></div>
            <div className="arch-box"><IRefresh /><div><b>worker</b><span>webhooks, sweeps, reconciliation</span></div></div>
            <div className="arch-box"><IActivity /><div><b>watcher</b><span>leader + standby per chain</span></div></div>
            <div className="arch-box signer"><ILock /><div><b>signer</b><span>keys; mTLS from worker only</span></div></div>
          </div>
          <div className="arch-arrow" aria-hidden="true"><i /></div>
          <div className="arch-col">
            <div className="arch-box store"><IDatabase /><div><b>PostgreSQL</b><span>ledger, RLS, sync replica</span></div></div>
            <div className="arch-box store"><IZap /><div><b>Redis</b><span>queues, rate limits</span></div></div>
            <div className="arch-box store"><IBranch /><div><b>RPC providers</b><span>3 per mainnet chain</span></div></div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CtaBand() {
  return (
    <section className="section tight">
      <div className="container">
        <div className="cta-band reveal">
          <div>
            <h2>See it run end to end.</h2>
            <p className="muted">Create a test key and send yourself a testnet deposit in a few minutes.</p>
          </div>
          <div className="row">
            <a className="btn primary" href={SIGNUP}>Start free <IArrow /></a>
            <a className="btn ghost" href={href('docs', 'quickstart')}>Quickstart</a>
          </div>
        </div>
      </div>
    </section>
  );
}
