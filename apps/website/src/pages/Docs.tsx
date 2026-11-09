import { useMemo, type ReactNode } from 'react';
import { BASE, depositCurl, depositNode, eventJson, invoiceNode, payoutNode, verifyTabs, webhookNode, widgetHtml } from '../content/snippets';
import { DASHBOARD, DEMO, href } from '../router';
import { Callout } from '../ui/bits';
import { Code, CodeWindow } from '../ui/Code';
import { DocShell, type NavGroup } from '../ui/DocShell';
import { IArrow, IBook, ICode, IFlask, IKey, ISend, IStore, IWallet, IWebhook } from '../ui/icons';

const NAV: NavGroup[] = [
  { title: 'Get started', items: [['overview', 'Overview'], ['quickstart', 'Quickstart'], ['test-mode', 'Test mode'], ['keys', 'API keys']] },
  { title: 'Web3 apps', items: [['deposits', 'Deposit address per user'], ['crediting', 'Crediting users'], ['payouts', 'Payouts to users']] },
  { title: 'Payments', items: [['invoices', 'Invoices & checkout'], ['widget', 'Checkout widget'], ['payment-links', 'Payment links'], ['marketplaces', 'Marketplaces']] },
  { title: 'Integrate', items: [['webhooks', 'Webhooks'], ['sdk', 'Node.js SDK'], ['retries', 'Retries & idempotency'], ['woocommerce', 'WooCommerce']] },
  { title: 'Launch', items: [['go-live', 'Go-live checklist']] },
];

function H(props: { id: string; children: ReactNode; eyebrow?: string }) {
  return (
    <header className="doc-h" id={props.id}>
      {props.eyebrow && <span className="eyebrow">{props.eyebrow}</span>}
      <h2>
        <a href={href('docs', props.id)} className="anchor" aria-label="Link to this section">#</a>
        {props.children}
      </h2>
    </header>
  );
}

function Steps(props: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="doc-steps">
      {props.items.map((s, i) => (
        <li key={s.title}>
          <span className="ds-n">{String(i + 1)}</span>
          <div>
            <h4>{s.title}</h4>
            <div className="ds-body">{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Docs() {
  const ids = useMemo(() => NAV.flatMap((g) => g.items.map(([id]) => id)), []);
  return (
    <DocShell page="docs" nav={NAV} ids={ids} title="Docs" subtitle="Guides">
      <section className="doc-sec">
        <div className="doc-intro" id="overview">
          <span className="eyebrow">Documentation</span>
          <h1>Build with Gateway</h1>
          <p className="lead">
            Guides for taking crypto deposits and paying users out from your app. Everything here works in test mode on BSC testnet; switch to a live
            key when you are ready.
          </p>
          <div className="doc-cards">
            <a className="doc-card spot" href={href('docs', 'quickstart')}><span className="ico-wrap"><IFlask /></span><b>Quickstart</b><span>Your first testnet deposit in minutes.</span><IArrow /></a>
            <a className="doc-card spot" href={href('docs', 'deposits')}><span className="ico-wrap teal"><IWallet /></span><b>Deposits per user</b><span>A permanent address for each user.</span><IArrow /></a>
            <a className="doc-card spot" href={href('docs', 'payouts')}><span className="ico-wrap violet"><ISend /></span><b>Payouts</b><span>Send USDT to users within limits.</span><IArrow /></a>
            <a className="doc-card spot" href={href('api')}><span className="ico-wrap blue"><IBook /></span><b>API reference</b><span>Every endpoint, object and error.</span><IArrow /></a>
          </div>
        </div>
      </section>

      <section className="doc-sec">
        <H id="quickstart" eyebrow="Get started">Quickstart</H>
        <p>From zero to a credited testnet deposit. You need a server that can make HTTPS requests and receive one.</p>
        <Steps
          items={[
            { title: 'Create an account and turn on 2FA', body: <p><a href={`${DASHBOARD}/#/signup`}>Sign up</a> in the dashboard and enable two-factor authentication: it is required to create API keys and webhook endpoints.</p> },
            { title: 'Choose how you receive', body: <p>Dashboard → Settings: a <strong>wallet address</strong> (forwarder, simplest), an <strong>extended public key</strong> (hardware wallets) or <strong>custody on</strong> (needed for payouts). Use different wallets for test and live.</p> },
            { title: 'Create a secret test key', body: <p>Dashboard → API keys: an <code>sk_test_…</code> key with <code>read</code> and <code>invoices:write</code> (add <code>payouts:write</code> for payouts). It is shown once: keep it in your server's secrets.</p> },
            { title: 'Get a deposit address for a user', body: <Code lang="bash" title="Terminal">{depositCurl}</Code> },
            { title: 'Add a webhook endpoint', body: <p>Dashboard → Webhooks: your public HTTPS URL. Keep the <code>whsec_…</code> secret and verify every request (see <a href={href('docs', 'webhooks')}>Webhooks</a>).</p> },
            { title: 'Send test tokens and watch it arrive', body: <p>Send the testnet token to the address. You will receive <code>invoice.detected</code>, <code>invoice.confirming</code>, <code>invoice.paid</code> and <code>invoice.settled</code>. Credit the user on the last one.</p> },
          ]}
        />
        <Callout kind="info">Want to see a finished integration first? The <a href={DEMO}>demo game wallet</a> does all of this in about 300 lines on the Node SDK.</Callout>
      </section>

      <section className="doc-sec">
        <H id="test-mode">Test mode</H>
        <p>
          Test mode is a full copy of the platform on <strong>BSC testnet</strong>. Test keys (<code>sk_test_…</code>) only see testnets and test
          objects; live keys only see mainnets. Webhook endpoints are per mode too: test events only go to test endpoints.
        </p>
        <div className="kv">
          <div><span>Network</span><b>BNB Smart Chain testnet (chain id 97)</b></div>
          <div><span>Token id</span><b><code>bsc-testnet:usdt</code></b></div>
          <div><span>Token</span><b>A test USDT (BEP-20, 18 decimals)</b></div>
          <div><span>Gas</span><b>tBNB from the BNB Chain testnet faucet</b></div>
          <div><span>Live token id</span><b><code>bsc:usdt</code> (BNB Smart Chain, chain id 56)</b></div>
        </div>
        <p>
          List what your key can use with <code>GET /v1/tokens</code>: each token has its <code>min_amount</code> and <code>min_confirmations</code>.
          Cancelling a test invoice produces an <code>invoice.cancelled</code> event, which is handy for testing your receiver.
        </p>
      </section>

      <section className="doc-sec">
        <H id="keys">API keys</H>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Key</th><th>Where</th><th>Can</th></tr></thead>
            <tbody>
              <tr><td><code>sk_test_…</code> / <code>sk_live_…</code></td><td>Your server only</td><td>The merchant API, within its scopes</td></tr>
              <tr><td><code>pk_test_…</code> / <code>pk_live_…</code></td><td>Browser (widget)</td><td><code>checkout</code> only</td></tr>
            </tbody>
          </table>
        </div>
        <p>Secret key scopes:</p>
        <div className="table-wrap">
          <table className="t">
            <tbody>
              <tr><td><code>read</code></td><td>Retrieve and list everything: invoices, deposit accounts, payouts, balances, events, exports.</td></tr>
              <tr><td><code>invoices:write</code></td><td>Deposit accounts, invoices, payment links, sub-merchants.</td></tr>
              <tr><td><code>payouts:write</code></td><td>Payouts to your users (custody on).</td></tr>
              <tr><td><code>withdrawals:write</code></td><td>Withdrawals of your balance to your payout address (custody on).</td></tr>
            </tbody>
          </table>
        </div>
        <Callout kind="danger"><strong>Never put a secret key in a browser, app or repository.</strong> Keys can carry an IP allowlist and an expiry; creating one needs a fresh 2FA code, and live keys need a verified email.</Callout>
      </section>

      <section className="doc-sec">
        <H id="deposits" eyebrow="Web3 apps">A deposit address per user</H>
        <p>
          For games, dApps and apps where users keep a balance. Each user gets a <strong>permanent</strong> address per token: they can save it and
          deposit any amount, any number of times.
        </p>
        <CodeWindow tabs={[{ label: 'deposit.ts', lang: 'js', code: depositNode }, { label: 'curl', lang: 'bash', code: depositCurl }]} />
        <ul className="doc-list">
          <li><code>201</code> the first time, <code>200</code> with the same address afterwards. Calling it on every page view is fine.</li>
          <li><code>customer_ref</code> is your own user id (1–200 characters). Use something stable and not personal, like an internal id.</li>
          <li>Show the address with its network: <strong>BNB Smart Chain (BEP-20)</strong>. Tokens sent on another network do not arrive.</li>
          <li>If you change your payout wallet (forwarder) or custody mode, old accounts are retired and the next call issues a new address.</li>
        </ul>
      </section>

      <section className="doc-sec">
        <H id="crediting">Crediting users</H>
        <p>
          Every transfer to a user's address becomes a deposit invoice with <code>kind: "deposit"</code>, your <code>customer_ref</code> and{' '}
          <code>amount</code> = what was sent. Credit on <code>invoice.settled</code>, exactly once, keyed by the invoice id.
        </p>
        <CodeWindow tabs={[{ label: 'webhook.ts', lang: 'js', code: webhookNode }, { label: 'event.json', lang: 'json', code: eventJson }]} numbered />
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Mode</th><th>Where the funds are</th><th>What to credit</th></tr></thead>
            <tbody>
              <tr><td>Wallet address</td><td>Forwarded to your wallet, fee split on-chain</td><td>The gross amount; keep the fee in your pricing</td></tr>
              <tr><td>Extended public key</td><td>In your own wallet</td><td>The gross amount</td></tr>
              <tr><td>Custody on</td><td>Swept to your gateway balance, minus the fee</td><td>The gross amount, or net if you pass the fee on</td></tr>
            </tbody>
          </table>
        </div>
        <Callout kind="warn">If the webhook is late, never guess: on page load you can list the user's deposits with <code>GET /v1/deposit-accounts/:id</code> and credit any settled one you have not credited yet. The demo does exactly this as a fallback.</Callout>
      </section>

      <section className="doc-sec">
        <H id="payouts">Payouts to users</H>
        <p>Custody on. Send USDT from your balance to a user's wallet with one call, with a <code>payouts:write</code> key.</p>
        <Steps
          items={[
            { title: 'Set your withdrawal limits', body: <p>Dashboard → Withdrawals: a one-time and a daily limit per token (2FA). Live payouts need both. They apply at once.</p> },
            { title: 'Debit the user first', body: <p>In your own ledger, in the same request that accepts the user's withdrawal. Then call the API.</p> },
            { title: 'Create the payout', body: <CodeWindow tabs={[{ label: 'payout.ts', lang: 'js', code: payoutNode }]} chrome={false} /> },
            { title: 'Follow it by webhook', body: <p><code>payout.approved</code> → <code>payout.sent</code> (with <code>tx_hash</code>) → <code>payout.confirmed</code>. On <code>payout.failed</code>, refund the user.</p> },
          ]}
        />
        <p>A flat payout fee is held together with the amount. Refusals carry a machine-readable <code>details.reason</code>: <code>409 conflict</code> for <code>over_tx_limit</code>, <code>over_day_limit</code>, <code>limits_required</code> and <code>insufficient_balance</code>; <code>400 validation_error</code> for <code>bad_destination</code>; <code>403</code> while custody is off.</p>
      </section>

      <section className="doc-sec">
        <H id="invoices" eyebrow="Payments">Invoices &amp; checkout</H>
        <p>Selling something at a fixed price? Create an invoice and send the customer to its hosted checkout: amount, address, QR code, network warning, countdown, live status and a browser-wallet pay button.</p>
        <CodeWindow tabs={[{ label: 'invoice.ts', lang: 'js', code: invoiceNode }]} />
        <ul className="doc-list">
          <li>Fulfil on <code>paid</code> or <code>overpaid</code> (then <code>settled</code>). Never on <code>detected</code> or <code>confirming</code>.</li>
          <li><code>underpaid</code>: the customer can still send the rest before the deadline. With custody on, still underpaid at the deadline closes as <code>partially_paid</code>: refund or ask for the rest.</li>
          <li><code>held</code>: paid but under risk review. Do not ship until it becomes <code>paid</code>.</li>
          <li><code>late_payment</code>: paid after the deadline; never fulfilled automatically.</li>
          <li><code>expires_in</code> is 300–86,400 seconds (default 1,800). <code>metadata</code>: up to 50 string pairs, 4 KB.</li>
        </ul>
      </section>

      <section className="doc-sec">
        <H id="widget">Checkout widget</H>
        <p>Open the hosted checkout in a dialog on your own page instead of redirecting.</p>
        <Steps
          items={[
            { title: 'Allow your site', body: <p>Dashboard → Checkout widget: list the exact origins that may embed it, e.g. <code>https://shop.example</code> (up to 10).</p> },
            { title: 'Create the invoice on your server', body: <p>With your secret key, then pass its <code>id</code> to the page.</p> },
            { title: 'Open it', body: <Code lang="html" title="checkout.html">{widgetHtml}</Code> },
          ]}
        />
        <Callout kind="info">The checkout refuses to be framed by any site not on your list and only talks to your page's exact origin. Treat <code>onPaid</code> as a display hint; fulfil from the webhook.</Callout>
      </section>

      <section className="doc-sec">
        <H id="payment-links">Payment links</H>
        <p>No code: <code>POST /v1/payment-links</code> (or the dashboard) with an amount and token returns a <code>url</code> you can share anywhere. Each customer who opens it and continues gets their own invoice and address. Cap open invoices with <code>max_pending_invoices</code>; deactivate with <code>DELETE</code>.</p>
      </section>

      <section className="doc-sec">
        <H id="marketplaces">Marketplaces</H>
        <p>Selling for others? Keep each seller as a sub-merchant with your own <code>reference</code>, then create invoices with <code>sub_merchant</code>. Invoices, events (<code>data.sub_merchant_id</code>) and exports carry it, and <code>GET /v1/sub-merchants/:id</code> returns totals per token. Payments still go to your wallet: you pay your sellers. A webhook endpoint can be limited to one seller.</p>
      </section>

      <section className="doc-sec">
        <H id="webhooks" eyebrow="Integrate">Webhooks</H>
        <p>
          Every status change is POSTed as JSON to each endpoint of its mode. The <code>gateway-signature</code> header is{' '}
          <code>t=&lt;unix&gt;,v1=&lt;hex&gt;[,v1=&lt;hex&gt;]</code>: an HMAC-SHA256 of <code>"&lt;t&gt;.&lt;raw body&gt;"</code> keyed with your{' '}
          <code>whsec_…</code> secret. Accept if any <code>v1</code> matches and <code>t</code> is within 5 minutes.
        </p>
        <CodeWindow tabs={verifyTabs} numbered />
        <ul className="doc-list">
          <li><strong>Use the raw body bytes.</strong> Re-serialized JSON will not match.</li>
          <li><strong>Answer 2xx within 10 s</strong>, then work. Anything else is retried: 1 m, 5 m, 30 m, 2 h, 5 h, then every 10 h, 12 attempts in all.</li>
          <li><strong>Deduplicate</strong> on the event <code>id</code> (also <code>gateway-event-id</code>). <strong>Order is not guaranteed.</strong></li>
          <li>Endpoints must be public; to test locally, use a tunnel. The dashboard shows every delivery and can resend it.</li>
        </ul>
        <p><a className="btn link" href={href('api', 'webhooks')}>Event types and the signature playground <IArrow /></a></p>
      </section>

      <section className="doc-sec">
        <H id="sdk">Node.js SDK</H>
        <p><code>@gw/sdk-node</code>: a typed client with zero dependencies (Node 18+), automatic idempotency keys, retries with backoff, and <code>constructEvent</code> for webhooks.</p>
        <div className="table-wrap">
          <table className="t sdk">
            <thead><tr><th>Resource</th><th>Methods</th></tr></thead>
            <tbody>
              <tr><td><code>depositAccounts</code></td><td>create, retrieve, list</td></tr>
              <tr><td><code>payouts</code></td><td>create, retrieve, list</td></tr>
              <tr><td><code>invoices</code></td><td>create, retrieve, list, cancel</td></tr>
              <tr><td><code>paymentLinks</code></td><td>create, retrieve, list</td></tr>
              <tr><td><code>subMerchants</code></td><td>create, retrieve, list, update</td></tr>
              <tr><td><code>events</code></td><td>retrieve, list</td></tr>
              <tr><td><code>exports</code></td><td>invoicesCsv, paymentsCsv</td></tr>
              <tr><td><code>balances()</code></td><td>per token</td></tr>
            </tbody>
          </table>
        </div>
        <Code lang="js" title="errors.ts">{`import { Gateway, GatewayError } from '@gw/sdk-node';

try {
  await gateway.payouts.create(params, { idempotencyKey: req.id });
} catch (err) {
  if (err instanceof GatewayError) {
    // err.status, err.code, err.message, err.requestId, err.details
    if (err.code === 'conflict') showLimitMessage(err.details);   // details.reason: over_day_limit, …
  }
  throw err;
}`}</Code>
        <p className="muted">Options: <code>apiKey</code>, <code>baseUrl</code> (e.g. <code>{BASE}</code>), <code>timeoutMs</code> (default 30 s), <code>maxRetries</code> (default 2: network errors, 429 and 5xx, only for GETs and POSTs with an idempotency key).</p>
      </section>

      <section className="doc-sec">
        <H id="retries">Retries &amp; idempotency</H>
        <p>Networks fail. Make every write safe to retry:</p>
        <ul className="doc-list">
          <li>Send <code>Idempotency-Key</code> on every POST: your order or request id works. Same key + same body returns the original response with <code>idempotent-replayed: true</code>.</li>
          <li>Same key with a different body is <code>409 idempotency_conflict</code>. Failed requests do not consume the key. Keys are scoped per account and mode.</li>
          <li>On <code>429</code>, wait for <code>retry-after</code>. The limit is 300 requests per minute per key.</li>
          <li>Log the <code>x-request-id</code> of failures; you can also send your own.</li>
        </ul>
      </section>

      <section className="doc-sec">
        <H id="woocommerce">WooCommerce</H>
        <p>The plugin adds "Pay with USDT" to classic and block checkout, creates one invoice per order, verifies webhooks and moves orders from the invoice's current state. Install it from <code>integrations/woocommerce/</code>, then paste a secret key and the webhook secret into its settings.</p>
        <div className="row doc-pills">
          <span className="badge"><IStore /> Classic + block checkout</span>
          <span className="badge"><IWebhook /> Verified webhooks</span>
          <span className="badge"><ICode /> No code</span>
        </div>
      </section>

      <section className="doc-sec">
        <H id="go-live" eyebrow="Launch">Go-live checklist</H>
        <ul className="golive">
          {[
            'Verify your email: live keys, xpubs, invoices and webhook endpoints need it.',
            'Set the live receiving mode and wallet. Live payout addresses and xpub changes activate after 24 hours.',
            'Create live keys with only the scopes you need; store them in your secret manager.',
            'Add a live webhook endpoint and verify signatures with the live secret.',
            'Custody on: set one-time and daily limits for every token you pay out.',
            'Switch the token id from bsc-testnet:usdt to bsc:usdt and show "BNB Smart Chain (BEP-20)" next to addresses.',
            'Credit exactly once by invoice id, and refund users on payout.failed.',
            'Invite your team with the least role they need, all with 2FA.',
          ].map((t) => (
            <li key={t}><label><input type="checkbox" /> <span>{t}</span></label></li>
          ))}
        </ul>
        <div className="doc-next">
          <a className="doc-card spot" href={href('api')}><span className="ico-wrap blue"><IBook /></span><b>API reference</b><span>Every endpoint, parameter and error code.</span><IArrow /></a>
          <a className="doc-card spot" href={href('security')}><span className="ico-wrap"><IKey /></span><b>Security</b><span>How your money is protected.</span><IArrow /></a>
        </div>
      </section>
    </DocShell>
  );
}
