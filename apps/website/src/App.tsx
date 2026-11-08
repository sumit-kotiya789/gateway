import { useEffect, useState, type ReactNode } from 'react';

const DASHBOARD = (import.meta.env.VITE_DASHBOARD_URL as string | undefined) ?? 'http://localhost:8080';
const DEMO = (import.meta.env.VITE_DEMO_URL as string | undefined) ?? 'http://localhost:8083';

type Page = 'home' | 'how' | 'pricing' | 'docs';
const PAGES: { id: Page; label: string }[] = [
  { id: 'home', label: 'Product' },
  { id: 'how', label: 'How it works' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'docs', label: 'Developers' },
];

function usePage(): Page {
  const read = (): Page => {
    const p = window.location.hash.replace(/^#\/?/, '').split('/')[0] as Page;
    return PAGES.some((x) => x.id === p) ? p : 'home';
  };
  const [page, setPage] = useState<Page>(read);
  useEffect(() => {
    const on = () => {
      setPage(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('hashchange', on); };
  }, []);
  return page;
}

export function App() {
  const page = usePage();
  return (
    <div className="site">
      <header className="site-head">
        <a className="site-brand" href="#/">
          <span className="site-mark">G</span> Gateway
        </a>
        <nav className="site-nav" aria-label="Main">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={page === p.id ? 'on' : ''}>{p.label}</a>
          ))}
        </nav>
        <div className="site-cta">
          <a className="btn secondary sm" href={DASHBOARD}>Log in</a>
          <a className="btn sm" href={`${DASHBOARD}/#/signup`}>Start free</a>
        </div>
      </header>
      <main>
        {page === 'home' && <Home />}
        {page === 'how' && <How />}
        {page === 'pricing' && <Pricing />}
        {page === 'docs' && <Docs />}
      </main>
      <footer className="site-foot">
        <span>Gateway · crypto payments on BNB Smart Chain</span>
        <span className="muted">Test mode runs on BSC testnet: no real money moves.</span>
      </footer>
    </div>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">For games, dApps and web3 apps</p>
        <h1>Let your users deposit and withdraw crypto, without running a wallet backend.</h1>
        <p className="lead">
          Every user gets their own permanent USDT deposit address. Deposits are detected, confirmed and reported to your app by webhook. With
          custody on, you also pay users out by API, within limits you set.
        </p>
        <div className="row">
          <a className="btn" href={`${DASHBOARD}/#/signup`}>Create an account</a>
          <a className="btn secondary" href={DEMO}>Try the live demo</a>
          <a className="btn secondary" href="#/docs">Read the docs</a>
        </div>
      </section>

      <section className="grid3">
        <Feature title="A deposit address per user">
          One call gives each of your users a permanent address. Any amount, any time. Every deposit arrives in your app as a webhook naming the
          user.
        </Feature>
        <Feature title="Custody on or off: your choice">
          Custody off: funds go straight to your own wallet, the fee is split off on-chain. Custody on: we hold the funds and you withdraw or pay
          users out.
        </Feature>
        <Feature title="Payouts to users">
          Custody on: send USDT to any user wallet with one API call. Automatic within your one-time and daily limits, never above them.
        </Feature>
        <Feature title="Invoices and checkout">
          Selling something? Create an invoice with an amount, send the customer to a hosted checkout page, or embed the widget.
        </Feature>
        <Feature title="Built for money">
          Every amount goes through a double-entry ledger and an hourly reconciliation. Keys stay in an isolated signer that re-checks every
          payout.
        </Feature>
        <Feature title="Test first, for free">
          Test mode runs on BSC testnet with a test token: build and test your integration end to end before any real money moves.
        </Feature>
      </section>

      <section className="split">
        <div>
          <h2>Three steps to accept deposits</h2>
          <ol className="steps">
            <li><strong>Sign up</strong> and create an API key in the dashboard.</li>
            <li><strong>Ask for your user's address</strong> and show it in your app.</li>
            <li><strong>Credit the user</strong> when the <code>invoice.settled</code> webhook arrives.</li>
          </ol>
        </div>
        <Code>{`const account = await gateway.depositAccounts.create({
  customer_ref: user.id,          // your own user id
  token: 'bsc:usdt',
});
showDepositAddress(account.address);`}</Code>
      </section>
    </>
  );
}

function How() {
  return (
    <section className="page">
      <h1>How it works</h1>
      <h2>Deposits</h2>
      <p>
        Your backend asks for a user's deposit address once per token. The same user always gets the same address. When anyone sends USDT to it,
        the gateway sees the transfer, waits for enough confirmations, records it as a deposit for that user, and sends your webhook. You credit the
        user in your app.
      </p>
      <div className="grid2">
        <div className="card">
          <h3>Custody off</h3>
          <p className="muted">You keep the keys and the funds.</p>
          <ul>
            <li><strong>Wallet address</strong>: paste any wallet. Each user address is a small contract that can only forward to your wallet,
              minus the fee. Nobody, not even us, can send the funds anywhere else.</li>
            <li><strong>Extended public key</strong>: for hardware wallets. User addresses are addresses of your own wallet.</li>
            <li>Payouts to users: from your own wallet.</li>
          </ul>
        </div>
        <div className="card">
          <h3>Custody on</h3>
          <p className="muted">We hold the funds for you.</p>
          <ul>
            <li>Deposits are moved to the platform wallet and added to your balance, minus the fee.</li>
            <li>Withdraw to your own wallet whenever you want.</li>
            <li>Pay your users out by API: automatic within the one-time and daily limits you set.</li>
          </ul>
        </div>
      </div>
      <h2>Safety</h2>
      <ul>
        <li>Two-factor authentication on every sensitive action; changes are recorded in a tamper-evident audit log.</li>
        <li>Keys live in a separate signer service that re-checks every transaction against the ledger before signing.</li>
        <li>Payouts never go to a gateway or blocked address; your limits are enforced three times (app, database, signer).</li>
        <li>Reconciliation compares the ledger with the blockchain every hour.</li>
      </ul>
    </section>
  );
}

function Pricing() {
  return (
    <section className="page">
      <h1>Pricing</h1>
      <p className="lead">No monthly fee. A small fee on what you receive; test mode is free.</p>
      <div className="grid3">
        <div className="card price">
          <h3>Deposits and invoices</h3>
          <p className="big">1%</p>
          <p className="muted">of each deposit or payment. Overpayments are not charged.</p>
        </div>
        <div className="card price">
          <h3>Payouts to users</h3>
          <p className="big">Flat fee</p>
          <p className="muted">per payout (custody on), covering the network fee. Agreed with your account.</p>
        </div>
        <div className="card price">
          <h3>Withdrawals</h3>
          <p className="big">Free</p>
          <p className="muted">to your own wallet (custody on). Network fees are on us.</p>
        </div>
      </div>
      <p className="muted">Volume pricing is available. Fees are shown on every invoice and deposit in your dashboard.</p>
    </section>
  );
}

function Docs() {
  return (
    <section className="page docs">
      <h1>Developers</h1>
      <p className="lead">
        A REST API with secret keys, signed webhooks and a Node.js SDK. Everything below works in test mode on BSC testnet (token
        <code> bsc-testnet:usdt</code>); switch to a live key and <code>bsc:usdt</code> when you are ready.
      </p>

      <h2>1. Keys</h2>
      <p>
        In the dashboard (two-factor authentication on), create a secret key. Scopes: <code>read</code>, <code>invoices:write</code> for deposit
        addresses and invoices, <code>payouts:write</code> for payouts to users. Keep it on your server: never in a browser or app.
      </p>

      <h2>2. A deposit address per user</h2>
      <Code>{`curl https://pay.example/v1/deposit-accounts \\
  -H "Authorization: Bearer sk_test_..." \\
  -H "Content-Type: application/json" \\
  -d '{"customer_ref":"user-42","token":"bsc-testnet:usdt"}'`}</Code>
      <p>
        Returns <code>{'{ "id": "…", "address": "0x…", "customer_ref": "user-42", "custody_mode": "…" }'}</code>: <code>201</code> the first time,
        <code> 200</code> with the same address afterwards. Show <code>address</code> to the user, with the network (BNB Smart Chain, BEP-20).
      </p>

      <h2>3. Webhooks: credit the user</h2>
      <p>
        Add an endpoint in the dashboard (Webhooks) and keep its <code>whsec_…</code> secret. Each deposit sends <code>invoice.*</code> events with
        <code> kind: "deposit"</code> and the user's <code>customer_ref</code>. Credit the user once, on <code>invoice.settled</code>, keyed by
        the invoice id. Always verify the signature on the raw body:
      </p>
      <Code>{`import { Gateway, constructEvent } from '@gw/sdk-node';

const gateway = new Gateway({ apiKey: process.env.GATEWAY_KEY, baseUrl: 'https://pay.example' });

app.post('/webhooks/gateway', express.raw({ type: '*/*' }), async (req, res) => {
  const event = constructEvent(req.body, req.get('gateway-signature'), process.env.GATEWAY_WHSEC);
  if (event.type === 'invoice.settled' && event.data.kind === 'deposit') {
    const inv = await gateway.invoices.retrieve(event.data.invoice_id);   // amounts in token units
    await creditOnce(inv.id, inv.customer_ref, inv.amount_received);
  }
  res.sendStatus(200);
});`}</Code>

      <h2>4. Payouts to users (custody on)</h2>
      <p>
        First set your withdrawal limits (dashboard, Withdrawals): a one-time and a daily limit per token. Live payouts need both. Then debit the
        user in your app and ask for the payout, with your own request id as the idempotency key:
      </p>
      <Code>{`const payout = await gateway.payouts.create(
  { customer_ref: 'user-42', to_address: '0xUserWallet…', token: 'bsc-testnet:usdt', amount: '25' },
  { idempotencyKey: withdrawalRequest.id },
);
// payout.status: approved -> sent -> confirmed (events payout.*); refund the user on payout.failed`}</Code>
      <p className="muted">
        A payout above your limits, to a gateway or blocked address, or above your balance (amount plus the payout fee) is refused with a clear
        reason (<code>over_tx_limit</code>, <code>over_day_limit</code>, <code>bad_destination</code>, <code>insufficient_balance</code>).
      </p>

      <h2>5. Invoices (optional)</h2>
      <p>
        To sell something at a fixed price, create an invoice and send the customer to its <code>checkout_url</code>; treat it as paid on
        <code> paid</code> / <code>overpaid</code>, final on <code>settled</code>.
      </p>
      <Code>{`await gateway.invoices.create({ amount: '25.00', token: 'bsc-testnet:usdt', external_order_id: 'order-1001' });`}</Code>

      <h2>Reference</h2>
      <ul>
        <li>Machine-readable API: <code>GET /v1/openapi.json</code> on the API.</li>
        <li>All responses use decimal strings in token units; send amounts the same way.</li>
        <li>Errors: <code>{'{ "error": { "code", "message", "details", "request_id" } }'}</code>.</li>
        <li>See it working end to end: <a href={DEMO}>the demo game wallet</a>.</li>
      </ul>
    </section>
  );
}

function Feature(props: { title: string; children: ReactNode }) {
  return (
    <div className="card feature">
      <h3>{props.title}</h3>
      <p className="muted">{props.children}</p>
    </div>
  );
}

function Code(props: { children: string }) {
  return (
    <pre className="code">
      <code>{props.children}</code>
    </pre>
  );
}
