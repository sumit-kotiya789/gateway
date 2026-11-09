import { useEffect, useRef, useState, type ReactNode } from 'react';
import { homeTabs } from '../content/snippets';
import { DEMO, SIGNUP, href } from '../router';
import { HeroCanvas } from '../three/HeroCanvas';
import { Faq, PseudoQr, SectionHead, type Qa } from '../ui/bits';
import { CodeWindow } from '../ui/Code';
import { prefersReducedMotion, useCountUp, useInView, useTicker } from '../ui/effects';
import {
  IActivity, IArrow, IBell, IBook, ICheck, ICode, ICoins, ICpu, IDatabase, IFingerprint, IFlask, IGamepad, IGauge, IGlobe, IHistory, IKey,
  ILayers, ILock, IPlay, IReceipt, IRefresh, IScale, ISend, IShield, IStore, IUsers, IWallet, IWebhook, IZap,
} from '../ui/icons';

export function Home() {
  return (
    <>
      <Hero />
      <UseCases />
      <Stats />
      <Bento />
      <Flow />
      <Developers />
      <Custody />
      <SecurityStrip />
      <LiveFeed />
      <section className="section">
        <div className="container narrow">
          <SectionHead center eyebrow="FAQ" title="Questions, answered." lead="The short version of what teams ask before they integrate." />
          <Faq items={FAQ} />
        </div>
      </section>
      <FinalCta />
    </>
  );
}

/* ---------------- Hero ---------------- */

function Hero() {
  return (
    <section className="hero">
      <HeroCanvas />
      <div className="hero-grid" aria-hidden="true" />
      <div className="container hero-inner">
        <div className="hero-copy">
          <a className="pill hero-pill" href={href('docs', 'deposits')}>
            <span className="tag">New</span>
            <span>Deposit addresses<span className="hide-xs"> per user</span> + payouts API</span>
            <IArrow />
          </a>
          <h1 className="hero-title">
            <span className="line"><span>Crypto deposits</span></span>
            <span className="line"><span>and payouts for</span></span>
            <span className="line"><span className="grad-text">every user.</span></span>
          </h1>
          <p className="lead hero-lead">
            Give each user of your app a permanent USDT address. Get a signed webhook when their deposit confirms. Pay them out with one API call,
            inside limits you set. No nodes, no wallet backend, no key management.
          </p>
          <div className="row hero-cta">
            <a className="btn primary lg" href={SIGNUP}>
              Start building free <IArrow />
            </a>
            <a className="btn ghost lg" href={DEMO}>
              <IPlay /> Live demo
            </a>
          </div>
          <ul className="hero-meta">
            <li><ICheck /> USDT (BEP-20) on BNB Smart Chain</li>
            <li><ICheck /> Free test mode on BSC testnet</li>
            <li><ICheck /> No monthly fee</li>
          </ul>
        </div>
        <div className="hero-floats" aria-hidden="true">
          <div className="float-card fc-address">
            <div className="fc-row">
              <span className="fc-ico"><IWallet /></span>
              <div>
                <div className="fc-label">Deposit address · user-42</div>
                <div className="fc-mono">0x7A3f…9c0F</div>
              </div>
              <span className="badge green">BEP-20</span>
            </div>
          </div>
          <div className="float-card fc-webhook">
            <div className="fc-row">
              <span className="fc-ico ok"><ICheck /></span>
              <div>
                <div className="fc-label mono">invoice.settled</div>
                <div className="fc-amount">+250.00 USDT</div>
              </div>
            </div>
            <div className="fc-bar"><span /></div>
            <div className="fc-foot"><span>15 / 15 confirmations</span><span>user-42</span></div>
          </div>
          <div className="float-card fc-payout">
            <div className="fc-row">
              <span className="fc-ico blue"><ISend /></span>
              <div>
                <div className="fc-label">Payout confirmed</div>
                <div className="fc-mono">25 USDT → 0x5aAe…eAed</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <a className="scroll-cue" href={href('home', 'use-cases')} aria-label="Scroll to content">
        <span />
      </a>
    </section>
  );
}

const USE_CASES: { icon: ReactNode; label: string }[] = [
  { icon: <IGamepad />, label: 'Web3 games' },
  { icon: <ILayers />, label: 'dApps' },
  { icon: <IStore />, label: 'Marketplaces' },
  { icon: <IUsers />, label: 'Creator platforms' },
  { icon: <ISend />, label: 'Telegram mini apps' },
  { icon: <IReceipt />, label: 'Online stores' },
  { icon: <ICode />, label: 'SaaS & APIs' },
  { icon: <IGlobe />, label: 'Communities' },
];

function UseCases() {
  const items = [...USE_CASES, ...USE_CASES];
  return (
    <section className="usecases" id="use-cases" aria-label="Built for">
      <p className="usecases-label">One integration for</p>
      <div className="marquee">
        <div className="marquee-track">
          {items.map((u, i) => (
            <span className="marquee-item" key={`${u.label}-${String(i)}`} aria-hidden={i >= USE_CASES.length}>
              {u.icon}
              {u.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Stats ---------------- */

function Stat(props: { to: number; suffix?: string; prefix?: string; label: string; detail: string; delay: string }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.4);
  const v = useCountUp(props.to, seen);
  return (
    <div ref={ref} className={`stat reveal ${props.delay}`}>
      <div className="stat-num">
        {props.prefix}
        {Math.round(v)}
        <span>{props.suffix}</span>
      </div>
      <div className="stat-label">{props.label}</div>
      <p className="stat-detail">{props.detail}</p>
    </div>
  );
}

function Stats() {
  return (
    <section className="section tight">
      <div className="container">
        <div className="stats">
          <Stat to={1} suffix="%" label="Flat fee" detail="On what you receive. No monthly fee, no setup fee; test mode is free." delay="d1" />
          <Stat to={15} label="Confirmations" detail="Before a USDT deposit is credited. 30 from 10,000 USDT, 60 from 100,000." delay="d2" />
          <Stat to={3} suffix="×" label="Limit checks" detail="Every payout limit is enforced in the app, the database and the signer." delay="d3" />
          <Stat to={12} label="Delivery attempts" detail="Per webhook, with backoff from 1 minute to 10 hours, until you answer 2xx." delay="d4" />
        </div>
      </div>
    </section>
  );
}

/* ---------------- Bento ---------------- */

function Bento() {
  const [custody, setCustody] = useState(false);
  return (
    <section className="section" id="features">
      <div className="container">
        <SectionHead
          eyebrow="The platform"
          title={<>Everything between a user's wallet <span className="grad-text">and your database.</span></>}
          lead="Address issuance, chain watching, confirmations, reorgs, ledger, webhooks, payouts and limits. You write the part that is your product."
        />
        <div className="bento">
          <article className="card spot b-address reveal">
            <div className="b-copy">
              <span className="ico-wrap"><IWallet /></span>
              <h3>A permanent address for every user</h3>
              <p>
                One call with your user id. The same user and token always get the same address, so users can save it, deposit any amount, any time,
                from any wallet or exchange.
              </p>
              <code className="b-code">POST /v1/deposit-accounts</code>
            </div>
            <div className="flip tilt" data-tilt="10">
              <div className="flip-inner">
                <div className="flip-face front">
                  <div className="fa-top">
                    <span className="badge green"><span className="dot" /> USDT · BEP-20</span>
                    <span className="fa-user">user-42</span>
                  </div>
                  <div className="fa-label">Your deposit address</div>
                  <div className="fa-addr">0x7A3f 92bC 41d0 aE5b 7c63 08Fd 2e9A 1b4C 6dE1 9c0F</div>
                  <div className="fa-foot">
                    <span>BNB Smart Chain</span>
                    <span>Flip for QR</span>
                  </div>
                </div>
                <div className="flip-face back">
                  <PseudoQr seed="user-42" />
                  <span>Send only USDT on BNB Smart Chain</span>
                </div>
              </div>
            </div>
          </article>

          <article className="card spot b-custody reveal d1">
            <span className="ico-wrap teal"><ILayers /></span>
            <h3>Custody on or off</h3>
            <p>Keep the keys and receive straight to your wallet, or let us hold funds so you can pay users out by API.</p>
            <div className="toggle-row">
              <span className={custody ? '' : 'on'}>Off</span>
              <button
                type="button"
                className={`switch ${custody ? 'on' : ''}`}
                role="switch"
                aria-checked={custody}
                aria-label="Custody"
                onClick={() => {
                  setCustody(!custody);
                }}
              >
                <i />
              </button>
              <span className={custody ? 'on' : ''}>On</span>
            </div>
            <div className={`mini-flow ${custody ? 'custody' : ''}`}>
              <span>User</span>
              <i />
              <span>{custody ? 'Platform wallet' : 'Forwarder contract'}</span>
              <i />
              <span>{custody ? 'Your balance' : 'Your wallet'}</span>
            </div>
          </article>

          <article className="card spot b-limits reveal d2">
            <span className="ico-wrap blue"><IGauge /></span>
            <h3>Payouts inside your limits</h3>
            <p>Automatic below your one-time and daily limits, refused above them. Never to a gateway or blocked address.</p>
            <div className="limits">
              <div className="limit">
                <div className="limit-top"><span>One-time limit</span><span className="mono">500 USDT</span></div>
                <div className="meter"><span className="m-40" /></div>
              </div>
              <div className="limit">
                <div className="limit-top"><span>Daily limit · used</span><span className="mono">3,100 / 5,000</span></div>
                <div className="meter"><span className="m-62" /></div>
              </div>
            </div>
          </article>

          <article className="card spot b-webhook reveal">
            <span className="ico-wrap violet"><IWebhook /></span>
            <h3>Signed webhooks</h3>
            <p>Every status change, signed with HMAC-SHA256 and retried with backoff until your endpoint answers.</p>
            <div className="sig">
              <div><span className="tk-p">gateway-signature</span>: t=1762682412,</div>
              <div className="typing">v1=5f2c9a1be07d44c3a8e6…</div>
            </div>
          </article>

          <article className="card spot b-ledger reveal d1">
            <span className="ico-wrap amber"><IScale /></span>
            <h3>Double-entry ledger</h3>
            <p>Every amount is a balanced journal. Append-only, reconciled against the chain every hour.</p>
            <div className="ledger">
              <div><span className="dr">Dr</span> custody_deposits<span className="mono">250.00</span></div>
              <div><span className="cr">Cr</span> merchant_available<span className="mono">247.50</span></div>
              <div><span className="cr">Cr</span> platform_fee_revenue<span className="mono">2.50</span></div>
            </div>
          </article>

          <article className="card spot b-checkout reveal d2">
            <span className="ico-wrap"><IReceipt /></span>
            <h3>Invoices &amp; hosted checkout</h3>
            <p>Selling something at a fixed price? Hosted checkout with QR, countdown and live status, or the embeddable widget.</p>
            <div className="mini-checkout">
              <div className="ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" /><circle className="arc" cx="18" cy="18" r="15.5" /></svg><span>24:58</span></div>
              <div>
                <div className="mc-amt">25.00 USDT</div>
                <div className="mc-st"><span className="dot live" /> Waiting for payment</div>
              </div>
            </div>
          </article>

          <article className="card spot b-test reveal">
            <span className="ico-wrap teal"><IFlask /></span>
            <h3>Test mode on BSC testnet</h3>
            <p>Same API, a test token, real blocks. Build your integration end to end before any real money moves.</p>
            <div className="row b-tags"><span className="badge amber">sk_test_…</span><span className="badge">bsc-testnet:usdt</span><span className="badge">free</span></div>
          </article>

          <article className="card spot b-team reveal d1">
            <span className="ico-wrap red"><IFingerprint /></span>
            <h3>Team roles &amp; audit log</h3>
            <p>Owner, admin, developer, finance, read-only. 2FA on every sensitive action, in a tamper-evident log.</p>
            <div className="avatars">
              <span>OW</span><span>AD</span><span>DV</span><span>FN</span><span>RO</span>
            </div>
          </article>

          <article className="card spot b-woo reveal">
            <span className="ico-wrap blue"><IStore /></span>
            <div className="b-woo-copy">
              <h3>Running a store? There is a WooCommerce plugin.</h3>
              <p>Adds "Pay with USDT" to classic and block checkout, creates one invoice per order and moves orders from verified webhooks. No code.</p>
            </div>
            <a className="btn ghost" href={href('docs', 'woocommerce')}>Plugin guide <IArrow /></a>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Flow ---------------- */

const FLOW: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <IWallet />, title: 'User sends USDT', text: 'To their permanent address, from any wallet or exchange.' },
  { icon: <IActivity />, title: 'Detected', text: 'The watcher reads Transfer logs of the exact token contract.' },
  { icon: <IRefresh />, title: 'Confirming', text: '15+ blocks deep and final. Reorgs move it back, never lose it.' },
  { icon: <IDatabase />, title: 'Booked', text: 'Invoice, payment, ledger and event in one DB transaction.' },
  { icon: <IWebhook />, title: 'Webhook signed', text: 'invoice.settled to your endpoint, retried until you answer.' },
  { icon: <IZap />, title: 'You credit the user', text: 'Once, keyed by the invoice id. Done.' },
];

function Flow() {
  const [ref, seen] = useInView<HTMLDivElement>(0.35);
  const step = useTicker(FLOW.length, 1700, seen);
  const active = prefersReducedMotion() ? FLOW.length - 1 : step;
  return (
    <section className="section flow-section" id="flow">
      <div className="container">
        <SectionHead
          center
          eyebrow="Under the hood"
          title={<>From a transfer to a credit, <span className="grad-text">in six steps.</span></>}
          lead="This is what happens for every deposit, in test mode and live. You only handle the last step."
        />
        <div ref={ref} className="flow reveal" data-step={active}>
          <div className="flow-line" aria-hidden="true"><span /></div>
          {FLOW.map((f, i) => (
            <div key={f.title} className="flow-step" data-done={i <= active} data-now={i === active}>
              <div className="flow-node">{f.icon}<span className="flow-n">{String(i + 1).padStart(2, '0')}</span></div>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Developers ---------------- */

function Developers() {
  return (
    <section className="section" id="developers">
      <div className="container dev">
        <div className="dev-copy reveal from-left">
          <span className="eyebrow">For developers</span>
          <h2>Ship it in an afternoon.</h2>
          <p className="lead">A small REST API, a typed Node.js SDK and signed webhooks. Every concept maps to one object you can retrieve and list.</p>
          <ul className="checks">
            <li><ICheck /><span><strong>Idempotent by design.</strong> Send an <code>Idempotency-Key</code> on any POST; the SDK adds one for you.</span></li>
            <li><ICheck /><span><strong>Exact money.</strong> Amounts are decimal strings in token units. Excess precision is rejected, never rounded.</span></li>
            <li><ICheck /><span><strong>Verifiable webhooks.</strong> Copy-paste verifiers for Node.js, Python, PHP and Go.</span></li>
            <li><ICheck /><span><strong>OpenAPI 3.1.</strong> Generated from the route schemas at <code>GET /v1/openapi.json</code>.</span></li>
            <li><ICheck /><span><strong>Stable errors.</strong> One envelope, stable codes, a request id on every response.</span></li>
          </ul>
          <div className="row dev-cta">
            <a className="btn primary" href={href('docs', 'quickstart')}>Quickstart <IArrow /></a>
            <a className="btn ghost" href={href('api')}><IBook /> API reference</a>
          </div>
        </div>
        <div className="dev-code reveal from-right d2">
          <CodeWindow
            tabs={homeTabs}
            glow
            numbered
            footer={
              <div className="status-line">
                <span className="dot live" />
                <span>201 Created · deposit_account · 0x7A3f…9c0F</span>
              </div>
            }
          />
        </div>
      </div>
    </section>
  );
}

/* ---------------- Custody ---------------- */

const MODES: { icon: ReactNode; tone: string; name: string; tag: string; text: string; rows: [string, string][] }[] = [
  {
    icon: <IWallet />,
    tone: '',
    name: 'Wallet address',
    tag: 'Custody off',
    text: 'Paste any wallet. Each user address is a small contract that can only forward to your wallet, minus the fee.',
    rows: [['Funds go to', 'Your wallet, automatically'], ['Fee', 'Split on-chain'], ['Keys', 'Nobody holds them']],
  },
  {
    icon: <IKey />,
    tone: 'blue',
    name: 'Extended public key',
    tag: 'Custody off',
    text: 'For hardware wallets: every user address is an address of your own wallet, derived from your xpub.',
    rows: [['Funds go to', 'Your own HD wallet'], ['Fee', 'Prepaid fee balance'], ['Keys', 'Only on your device']],
  },
  {
    icon: <ILock />,
    tone: 'violet',
    name: 'Custody on',
    tag: 'Managed',
    text: 'We hold the funds in an isolated signer. Withdraw to your wallet whenever you want, or pay your users out by API.',
    rows: [['Funds go to', 'Your gateway balance'], ['Fee', 'Deducted at settlement'], ['Payouts', 'By API, within limits']],
  },
];

function Custody() {
  return (
    <section className="section" id="custody">
      <div className="container">
        <SectionHead
          eyebrow="Your keys, your call"
          title={<>Three ways to receive. <span className="grad-text">Same API.</span></>}
          lead="Choose per account. Invoices, deposits and webhooks look the same in every mode; only where the money goes changes."
        />
        <div className="grid g3">
          {MODES.map((m, i) => (
            <article key={m.name} className={`card spot mode tilt reveal d${String(i + 1)}`} data-tilt="5">
              <div className="mode-top">
                <span className={`ico-wrap ${m.tone}`}>{m.icon}</span>
                <span className="badge">{m.tag}</span>
              </div>
              <h3>{m.name}</h3>
              <p>{m.text}</p>
              <dl className="mode-rows">
                {m.rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
        <p className="center-link reveal">
          <a className="btn link" href={href('how', 'custody')}>Compare the modes in detail <IArrow /></a>
        </p>
      </div>
    </section>
  );
}

/* ---------------- Security strip ---------------- */

const SEC: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <ICpu />, title: 'Isolated signer', text: 'Keys live in a separate service that re-checks every transaction against the ledger before it signs.' },
  { icon: <IScale />, title: 'Balanced, append-only ledger', text: 'Database triggers reject unbalanced or edited journals. Hourly reconciliation with the chain.' },
  { icon: <IGauge />, title: 'Limits enforced three times', text: 'In the app, in the database and in the signer. A bug in one layer is caught by the next.' },
  { icon: <IFingerprint />, title: '2FA step-up', text: 'Fresh TOTP codes for keys, webhooks, payout addresses and limits. Each code works once.' },
  { icon: <IHistory />, title: 'Tamper-evident audit log', text: 'Hash-chained entries you can verify. Every change names who made it and why.' },
  { icon: <IShield />, title: 'Cooling-off on changes', text: 'A new live payout address or xpub activates after 24 hours, and owners are emailed.' },
];

function SecurityStrip() {
  return (
    <section className="section sec-strip">
      <div className="container">
        <div className="sec-head">
          <SectionHead
            eyebrow="Security"
            title={<>Built like it holds money. <span className="grad-text">Because it does.</span></>}
            lead="Defense in depth: every control that guards a payout exists in more than one layer."
          />
          <a className="btn ghost reveal" href={href('security')}>
            <IShield /> Security overview
          </a>
        </div>
        <div className="grid g3">
          {SEC.map((s, i) => (
            <div key={s.title} className={`sec-item reveal d${String((i % 3) + 1)}`}>
              <span className="sec-ico">{s.icon}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Live feed (simulation) ---------------- */

type Stage = 0 | 1 | 2 | 3 | 4;
interface FeedRow { id: number; user: string; amount: string; stage: Stage; conf: number }
const STAGES = ['detected', 'confirming', 'paid', 'settled', 'credited'] as const;
const AMOUNTS = ['120.00', '45.50', '1,250.00', '9.99', '300.00', '75.25', '18.00', '640.00', '2,000.00', '33.10'];

function makeRow(n: number): FeedRow {
  return { id: n, user: `user-${String(1000 + ((n * 7919) % 9000))}`, amount: AMOUNTS[n % AMOUNTS.length] ?? '10.00', stage: 0, conf: 0 };
}

function LiveFeed() {
  const [ref, seen] = useInView<HTMLDivElement>(0.25);
  const [rows, setRows] = useState<FeedRow[]>(() => [4, 3, 2, 1, 0].map((n, i) => ({ ...makeRow(n), stage: Math.min(4, i) as Stage, conf: i >= 2 ? 15 : i * 6 })));
  const [next, setNext] = useState(5);
  const counter = useRef(5);
  useEffect(() => {
    if (!seen || prefersReducedMotion()) return;
    const t = window.setInterval(() => {
      setRows((rs) => rs.map((r) => {
        if (r.stage === 1 && r.conf < 15) return { ...r, conf: Math.min(15, r.conf + 3) };
        if (r.stage < 4) return { ...r, stage: (r.stage + 1) as Stage, conf: r.stage === 0 ? 1 : 15 };
        return r;
      }));
    }, 900);
    const t2 = window.setInterval(() => {
      const n = counter.current;
      counter.current = n + 1;
      setRows((rs) => [makeRow(n), ...rs].slice(0, 6));
      setNext(n + 1);
    }, 3600);
    return () => {
      window.clearInterval(t);
      window.clearInterval(t2);
    };
  }, [seen]);
  return (
    <section className="section">
      <div className="container feed-wrap">
        <div className="feed-copy reveal from-left">
          <span className="eyebrow">Observability</span>
          <h2>Every deposit, accounted for.</h2>
          <p className="lead">
            Each transfer becomes a deposit with a full history: tx hash, block, confirmations, fee, and every status change as an event you can
            list, filter and replay.
          </p>
          <ul className="checks">
            <li><ICheck /><span>Event log: <code>GET /v1/events</code>, newest first, filter by type.</span></li>
            <li><ICheck /><span>Delivery log per endpoint, with one-click resend.</span></li>
            <li><ICheck /><span>CSV exports of invoices and payments for accounting.</span></li>
          </ul>
        </div>
        <div ref={ref} className="feed reveal from-right d2" aria-label="Simulated test-mode activity">
          <div className="feed-head">
            <span className="row"><span className="dot live" /> Deposits</span>
            <span className="badge amber">Simulation · test mode</span>
          </div>
          <div className="feed-rows" aria-hidden="true">
            {rows.map((r) => (
              <div key={r.id} className={`feed-row s${String(r.stage)}`}>
                <span className="fr-user"><span className="avatar">{r.user.slice(5, 7)}</span>{r.user}</span>
                <span className="fr-amt mono">+{r.amount} USDT</span>
                <span className="fr-conf mono">{r.stage === 1 ? `${String(r.conf)}/15` : r.stage >= 2 ? '15/15' : '0/15'}</span>
                <span className={`fr-st st-${STAGES[r.stage]}`}>{STAGES[r.stage]}</span>
              </div>
            ))}
          </div>
          <div className="feed-foot mono">
            <span>{String(next)} deposits simulated</span>
            <span>webhooks: 200 OK</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- FAQ + CTA ---------------- */

const FAQ: Qa[] = [
  { q: 'Which chains and tokens are supported?', a: 'USDT (BEP-20) on BNB Smart Chain. Test mode runs on BSC testnet with a test token. Chains and tokens are registry entries on our side, so adding one does not change your integration: you pass a different `token` id.' },
  { q: 'Do I have to let you hold my users’ funds?', a: 'No. With custody off, funds go straight to your own wallet: either through a forwarder contract that can only pay your wallet (minus the fee), or to addresses derived from your own extended public key. Custody on is optional and is what enables payouts by API.' },
  { q: 'How fast is a deposit credited?', a: 'After 15 confirmations on BNB Smart Chain for typical amounts, and only once the block is final. Larger deposits wait longer: 30 confirmations from 10,000 USDT and 60 from 100,000 USDT.' },
  { q: 'What if a user sends the wrong amount?', a: 'Deposits to a permanent address accept any amount: each transfer is credited as sent. Invoices with a fixed price track `underpaid` and `overpaid`; with custody on, an invoice still underpaid at its deadline closes as `partially_paid` and what arrived is credited.' },
  { q: 'What happens when my webhook endpoint is down?', a: 'Deliveries are retried 12 times with backoff (1 m, 5 m, 30 m, 2 h, 5 h, then every 10 h). You can also list every event with `GET /v1/events` and resend any delivery from the dashboard.' },
  { q: 'How are payouts protected?', a: 'Your one-time and daily limits are checked in the app, the database and the signer. Payouts never go to a gateway or blocked address, and the signer re-checks every transaction against the ledger before signing.' },
  { q: 'What does it cost?', a: '1% of each deposit or payment, no monthly fee. Payouts to users carry a flat fee per payout that covers the network fee; withdrawals to your own wallet are free. Test mode is free. See [pricing](#/pricing).' },
  { q: 'Can I try it without writing code?', a: `Yes. Open the [live demo](${DEMO}) game wallet, or create test invoices and payment links from the dashboard and pay them with the testnet token.` },
];

function FinalCta() {
  return (
    <section className="section final">
      <div className="container">
        <div className="final-card reveal scale">
          <div className="final-glow" aria-hidden="true" />
          <div className="final-rings" aria-hidden="true"><i /><i /><i /></div>
          <span className="eyebrow">Start in test mode</span>
          <h2>Your users are one API call away from their first deposit.</h2>
          <p className="lead">Create an account, make a test key, and watch a testnet deposit arrive as a signed webhook. No card, no call.</p>
          <div className="row final-cta">
            <a className="btn primary lg" href={SIGNUP}>Create a free account <IArrow /></a>
            <a className="btn ghost lg" href={href('docs', 'quickstart')}><ICoins /> Read the quickstart</a>
          </div>
          <div className="final-meta">
            <span><IBell /> Webhooks</span>
            <span><ISend /> Payouts</span>
            <span><IShield /> 2FA everywhere</span>
            <span><IFlask /> Free testnet</span>
          </div>
        </div>
      </div>
    </section>
  );
}
