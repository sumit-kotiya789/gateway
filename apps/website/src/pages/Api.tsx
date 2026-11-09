import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ERROR_CODES, EVENT_TYPES, RESOURCES, type Endpoint, type Field } from '../content/api';
import { BASE, eventJson, verifyTabs, widgetHtml } from '../content/snippets';
import { href } from '../router';
import { Callout, Method, Rich } from '../ui/bits';
import { Code, CodeWindow, type CodeTab } from '../ui/Code';
import { DocShell, type NavGroup } from '../ui/DocShell';
import { ICheck, IKey, ILock, IX } from '../ui/icons';

const BASICS: [string, string][] = [
  ['introduction', 'Introduction'],
  ['authentication', 'Authentication'],
  ['amounts', 'Amounts'],
  ['errors', 'Errors'],
  ['idempotency', 'Idempotency'],
  ['pagination', 'Pagination'],
  ['rate-limits', 'Rate limits'],
  ['request-ids', 'Request ids'],
];

function buildNav(): NavGroup[] {
  const res: NavGroup[] = RESOURCES.map((r) => ({
    title: r.title,
    items: [
      ...(r.object ? [[`${r.id}-object`, 'The object'] as [string, string]] : []),
      ...r.endpoints.map((e) => [e.id, e.title, e.method] as [string, string, string]),
    ],
  }));
  return [
    { title: 'Basics', items: BASICS },
    ...res,
    { title: 'Webhooks', items: [['webhooks', 'Signatures'], ['event-types', 'Event types'], ['playground', 'Signature playground']] },
    { title: 'Checkout', items: [['checkout', 'Hosted checkout'], ['widget-js', 'widget.js']] },
    { title: 'Reference', items: [['statuses', 'Statuses'], ['error-codes', 'Error codes']] },
  ];
}

function Sec(props: { id: string; title: string; children: ReactNode; kicker?: string }) {
  return (
    <section className="api-sec" id={props.id}>
      {props.kicker && <span className="eyebrow">{props.kicker}</span>}
      <h2>
        <a href={href('api', props.id)} className="anchor" aria-label="Link to this section">#</a>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Fields(props: { title: string; fields: Field[] }) {
  return (
    <div className="fields">
      <h4>{props.title}</h4>
      <dl>
        {props.fields.map((f) => (
          <div key={f.name} className="field-row">
            <dt>
              <code className="f-name">{f.name}</code>
              {f.type && <span className="f-type">{f.type}</span>}
              {f.req && <span className="f-req">required</span>}
            </dt>
            <dd><Rich text={f.desc} /></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EndpointBlock(props: { e: Endpoint }) {
  const e = props.e;
  const tabs: CodeTab[] = [{ label: 'cURL', lang: 'bash', code: e.curl }];
  if (e.node) tabs.push({ label: 'Node.js', lang: 'js', code: e.node });
  const isCsv = e.returns.includes('csv');
  return (
    <section className="api-ep" id={e.id}>
      <div className="ep-doc">
        <h3>
          <a href={href('api', e.id)} className="anchor" aria-label="Link to this endpoint">#</a>
          {e.title}
        </h3>
        <div className="ep-line">
          <Method m={e.method} />
          <code className="ep-path">{e.path}</code>
        </div>
        <div className="ep-auth"><IKey /> <span>Scope</span> <code>{e.auth}</code></div>
        {e.desc.map((d) => <p key={d}><Rich text={d} /></p>)}
        {e.pathParams && <Fields title="Path parameters" fields={e.pathParams} />}
        {e.query && <Fields title="Query parameters" fields={e.query} />}
        {e.body && <Fields title="Body parameters" fields={e.body} />}
        <div className="ep-returns"><h4>Returns</h4><p><Rich text={e.returns} /></p></div>
        {e.notes?.map((n) => (
          <Callout key={n} kind="info"><Rich text={n} /></Callout>
        ))}
      </div>
      <div className="ep-code">
        <CodeWindow tabs={tabs} compact title="Request" />
        <CodeWindow
          tabs={[{ label: `Response · ${e.status}`, lang: isCsv ? 'text' : 'json', code: e.response }]}
          compact
          chrome={false}
          className="resp"
        />
      </div>
    </section>
  );
}

/* ---------- Signature playground (runs locally with Web Crypto) ---------- */

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function Playground() {
  const [secret, setSecret] = useState('whsec_test_playground_secret');
  const [ts, setTs] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [body, setBody] = useState(eventJson);
  const [check, setCheck] = useState('');
  const [sig, setSig] = useState<string | null>(null);
  const supported = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

  useEffect(() => {
    if (!supported) return;
    let live = true;
    hmacHex(secret, `${ts}.${body}`).then(
      (h) => {
        if (live) setSig(h);
      },
      () => {
        if (live) setSig(null);
      },
    );
    return () => {
      live = false;
    };
  }, [secret, ts, body, supported]);

  const header = sig ? `t=${ts},v1=${sig}` : '';
  const candidate = check.trim();
  const verdict = !candidate ? null : candidate === header || candidate.split(',').some((p) => p === `v1=${sig ?? ''}`);
  return (
    <div className="playground">
      <div className="pg-in">
        <label className="field">
          <span>Endpoint secret</span>
          <div className="field-box"><input value={secret} onChange={(e) => { setSecret(e.target.value); }} spellCheck={false} /></div>
        </label>
        <label className="field">
          <span>Timestamp (t)</span>
          <div className="field-box">
            <input value={ts} inputMode="numeric" onChange={(e) => { setTs(e.target.value.replace(/\D/g, '')); }} />
            <button type="button" className="unit btn-unit" onClick={() => { setTs(String(Math.floor(Date.now() / 1000))); }}>now</button>
          </div>
        </label>
        <label className="field">
          <span>Raw body</span>
          <textarea value={body} onChange={(e) => { setBody(e.target.value); }} rows={10} spellCheck={false} />
        </label>
      </div>
      <div className="pg-out">
        <div className="pg-step"><span className="mono faint">1 · signed payload</span><code className="pg-mono">{ts}.{body.length > 60 ? `${body.slice(0, 60).replace(/\s+/g, ' ')}…` : body}</code></div>
        <div className="pg-step"><span className="mono faint">2 · HMAC-SHA256(secret, payload)</span><code className="pg-mono hl">{supported ? sig ?? '…' : 'Web Crypto needs a secure context (https or localhost).'}</code></div>
        <div className="pg-step"><span className="mono faint">3 · gateway-signature header</span><code className="pg-mono">{header || '…'}</code></div>
        <label className="field">
          <span>Paste a header to check it</span>
          <div className="field-box"><input value={check} onChange={(e) => { setCheck(e.target.value); }} placeholder="t=…,v1=…" spellCheck={false} /></div>
        </label>
        {verdict !== null && (
          <div className={`pg-verdict ${verdict ? 'ok' : 'bad'}`}>{verdict ? <ICheck /> : <IX />} {verdict ? 'Signature matches this secret and body.' : 'No v1 value matches. Check the secret and that the body is byte-for-byte the raw body.'}</div>
        )}
        <p className="faint small">Computed in your browser; nothing is sent anywhere. Use test secrets only.</p>
      </div>
    </div>
  );
}

/* ---------- Page ---------- */

export function Api() {
  const nav = useMemo(buildNav, []);
  const ids = useMemo(() => nav.flatMap((g) => g.items.map((it) => it[0])), [nav]);
  return (
    <DocShell page="api" nav={nav} ids={ids} title="API reference" subtitle="Reference" search wide>
      <Sec id="introduction" title="API reference" kicker="v1 · REST · JSON">
        <p className="lead">
          The Gateway API is a REST API with predictable resource URLs, JSON bodies and standard HTTP codes. Authenticate with a secret key; the key
          decides the mode, so the same code runs in test and live.
        </p>
        <div className="api-intro">
          <div className="kv">
            <div><span>Base URL</span><b><code>{BASE}</code> <span className="faint">(your gateway's API origin)</span></b></div>
            <div><span>Version</span><b><code>/v1</code> in the path</b></div>
            <div><span>Format</span><b>JSON request and response bodies, UTF-8</b></div>
            <div><span>OpenAPI 3.1</span><b><code>GET /v1/openapi.json</code>, generated from the route schemas</b></div>
            <div><span>SDK</span><b><code>@gw/sdk-node</code> for Node.js 18+</b></div>
          </div>
          <CodeWindow compact title="Your first request" tabs={[{ label: 'cURL', lang: 'bash', code: `curl ${BASE}/v1/account \\\n  -H "Authorization: Bearer sk_test_..."` }]} />
        </div>
        <Callout kind="info">Examples on this page use illustrative ids, addresses and hashes. Unknown fields in request bodies are rejected, so typos fail loudly instead of being ignored.</Callout>
      </Sec>

      <Sec id="authentication" title="Authentication">
        <p>Send your secret key as a bearer token. Keys are created in the dashboard (2FA required), shown once, and can carry an IP allowlist and an expiry.</p>
        <Code lang="http" title="Header">{'GET /v1/account\nAuthorization: Bearer sk_test_51Hx…'}</Code>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Scope</th><th>Grants</th></tr></thead>
            <tbody>
              <tr><td><code>read</code></td><td>Every GET on the merchant API.</td></tr>
              <tr><td><code>invoices:write</code></td><td>Deposit accounts, invoices, payment links, sub-merchants.</td></tr>
              <tr><td><code>payouts:write</code></td><td>Payouts to your users.</td></tr>
              <tr><td><code>withdrawals:write</code></td><td>Withdrawals to your payout address.</td></tr>
            </tbody>
          </table>
        </div>
        <div className="grid g2 auth-grid">
          <div className="mini"><span className="mini-ico"><ILock /></span><h4>Secret keys</h4><p><code>sk_test_…</code> and <code>sk_live_…</code>. Server-side only. Test keys see test objects and testnets; live keys see live objects and mainnets.</p></div>
          <div className="mini"><span className="mini-ico"><IKey /></span><h4>Publishable keys</h4><p><code>pk_test_…</code> and <code>pk_live_…</code>, scope <code>checkout</code> only. Safe in a browser.</p></div>
        </div>
        <Callout kind="warn">Live mode needs a verified email for live keys, xpubs, invoices and webhook endpoints (<code>403</code>, <code>details.reason = "email_unverified"</code>).</Callout>
      </Sec>

      <Sec id="amounts" title="Amounts">
        <p>Amounts are <strong>decimal strings in token units</strong>, never JSON numbers: <code>"25.5"</code>, not <code>25.5</code>. More decimals than the token supports are rejected (<code>invalid_amount</code>), never rounded. Responses use canonical form without trailing zeros: <code>"25.00"</code> comes back as <code>"25"</code>.</p>
        <Callout kind="info">USDT on BNB Smart Chain has <strong>18 decimals</strong>. Do maths with integers or a decimal library, not floats.</Callout>
      </Sec>

      <Sec id="errors" title="Errors">
        <p>Every non-2xx response has the same envelope. <code>code</code> is stable and safe to branch on; <code>message</code> is for humans; <code>details</code> names fields or a <code>reason</code>.</p>
        <Code lang="json" title="Error">{`{
  "error": {
    "code": "conflict",
    "message": "amount above your daily withdrawal limit (1500 left for the next 24 hours)",
    "details": { "reason": "over_day_limit" },
    "request_id": "req_8f2c1a7b9d3e"
  }
}`}</Code>
        <p>See all <a href={href('api', 'error-codes')}>error codes</a>. New codes may be added; treat unknown ones by their HTTP status.</p>
      </Sec>

      <Sec id="idempotency" title="Idempotency">
        <p>Send <code>Idempotency-Key: &lt;1–255 printable ASCII&gt;</code> on every state-changing POST. A retry with the same key and body returns the original response with the header <code>idempotent-replayed: true</code>. The same key with a different body is <code>409 idempotency_conflict</code>. Failed requests do not consume the key. Keys are scoped per account and mode.</p>
        <Code lang="http" title="Retry-safe request">{'POST /v1/payouts\nAuthorization: Bearer sk_test_…\nIdempotency-Key: wr-7781\nContent-Type: application/json\n\n{ "customer_ref": "user-42", "to_address": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "token": "bsc-testnet:usdt", "amount": "25" }'}</Code>
      </Sec>

      <Sec id="pagination" title="Pagination">
        <p>Lists return newest first with <code>limit</code> (1–100, default 20) and a cursor. Pass <code>next_cursor</code> as <code>starting_after</code> while <code>has_more</code> is true.</p>
        <Code lang="js" title="Iterate every page">{`let cursor;
do {
  const page = await gateway.invoices.list({ limit: 100, starting_after: cursor });
  for (const inv of page.data) handle(inv);
  cursor = page.has_more ? page.next_cursor : undefined;
} while (cursor);`}</Code>
      </Sec>

      <Sec id="rate-limits" title="Rate limits">
        <p><strong>300 requests per minute per API key</strong> (per IP when unauthenticated); exports 10 per minute. Every response carries <code>x-ratelimit-limit</code>, <code>x-ratelimit-remaining</code> and <code>x-ratelimit-reset</code>; a <code>429</code> adds <code>retry-after</code>. Body size is limited to 100 KB.</p>
      </Sec>

      <Sec id="request-ids" title="Request ids">
        <p>Every response has an <code>x-request-id</code>. Send your own (<code>[A-Za-z0-9._-]{'{8,128}'}</code>) to correlate logs; otherwise one is generated. Include it when you report a problem. Secrets never go in query strings.</p>
      </Sec>

      {RESOURCES.map((r) => (
        <div key={r.id} className="api-resource" id={r.id}>
          <div className="api-sec res-head">
            <span className="eyebrow">Resource</span>
            <h2>{r.title}</h2>
            {r.intro.map((p) => <p key={p}><Rich text={p} /></p>)}
          </div>
          {r.object && (
            <section className="api-ep" id={`${r.id}-object`}>
              <div className="ep-doc">
                <h3>{r.object.name}</h3>
                <Fields title="Attributes" fields={r.object.fields} />
              </div>
              <div className="ep-code">
                <CodeWindow compact chrome={false} tabs={[{ label: r.object.name.replace(/^The /, ''), lang: 'json', code: r.object.json }]} />
              </div>
            </section>
          )}
          {r.endpoints.map((e) => <EndpointBlock key={e.id} e={e} />)}
        </div>
      ))}

      <Sec id="webhooks" title="Webhook signatures" kicker="Webhooks">
        <p>Each event is POSTed as JSON to every endpoint of its mode, with these headers:</p>
        <div className="table-wrap">
          <table className="t">
            <tbody>
              <tr><td><code>gateway-signature</code></td><td><code>t=&lt;unix&gt;,v1=&lt;hex&gt;[,v1=&lt;hex&gt;]</code>: HMAC-SHA256 of <code>"&lt;t&gt;.&lt;raw body&gt;"</code> with your <code>whsec_…</code> secret. Several <code>v1</code> values appear while a secret rotates.</td></tr>
              <tr><td><code>gateway-event-id</code></td><td>The event <code>id</code>: deduplicate on it.</td></tr>
            </tbody>
          </table>
        </div>
        <p>Accept if any <code>v1</code> matches and <code>t</code> is within 5 minutes. Answer 2xx within 10 seconds; anything else (including redirects) is retried at 1 m, 5 m, 30 m, 2 h, 5 h, then every 10 h, 12 attempts in all.</p>
        <CodeWindow tabs={verifyTabs} numbered />
      </Sec>

      <Sec id="event-types" title="Event types">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Type</th><th>Meaning</th></tr></thead>
            <tbody>
              {EVENT_TYPES.map(([t, d]) => (
                <tr key={t}><td><code>{t}</code></td><td><Rich text={d} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <Callout kind="warn">Delivery is at-least-once and order is not guaranteed. Act on <code>data.status</code>, or fetch the object for its current state.</Callout>
      </Sec>

      <Sec id="playground" title="Signature playground">
        <p>See exactly what your verifier should compute. Change the secret, timestamp or body and the signature updates live.</p>
        <Playground />
      </Sec>

      <Sec id="checkout" title="Hosted checkout" kicker="Checkout">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Route</th><th>What</th></tr></thead>
            <tbody>
              <tr><td><Method m="GET" small /> <code>/checkout/:id</code></td><td>The hosted page for an invoice: amount, address, QR, network warning, countdown, live status, browser-wallet button.</td></tr>
              <tr><td><Method m="GET" small /> <code>/checkout/:id/status</code></td><td>Public status of one invoice (polled by the page).</td></tr>
              <tr><td><Method m="GET" small /> <code>/checkout/:id?embed=1&amp;origin=…</code></td><td>Embeddable mode, framable only by your allowlisted origin; posts status to it.</td></tr>
              <tr><td><Method m="GET" small /> <code>/pay/:id</code></td><td>A payment link page; continuing creates an invoice and redirects (303) to its checkout.</td></tr>
            </tbody>
          </table>
        </div>
      </Sec>

      <Sec id="widget-js" title="widget.js">
        <p>Opens the checkout in a dialog on your page. Allow your site's exact origin first (dashboard → Checkout widget).</p>
        <Code lang="html" title="checkout.html">{widgetHtml}</Code>
      </Sec>

      <Sec id="statuses" title="Statuses" kicker="Reference">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Invoice status</th><th>Fulfil?</th><th>Final?</th><th>Meaning</th></tr></thead>
            <tbody>
              {([
                ['pending', false, false, 'Waiting for payment.'],
                ['detected', false, false, 'Seen on chain, not confirmed.'],
                ['confirming', false, false, 'Waiting for confirmations and finality.'],
                ['paid', true, false, 'Confirmed payments cover the amount.'],
                ['overpaid', true, false, 'More than the amount arrived.'],
                ['underpaid', false, false, 'Less than the amount; the customer can send the rest.'],
                ['settled', true, true, 'Fee booked (and swept, custody on). Credit deposits here.'],
                ['partially_paid', false, true, 'Custody on: underpaid at the deadline; what arrived was credited.'],
                ['held', false, false, 'Paid, under risk review.'],
                ['expired', false, false, 'No payment before the deadline.'],
                ['cancelled', false, false, 'Cancelled by you.'],
                ['late_payment', false, false, 'Paid after the deadline; manual decision only.'],
                ['failed', false, true, 'Rejected or not created.'],
              ] as [string, boolean, boolean, string][]).map(([s, f, fin, d]) => (
                <tr key={s}>
                  <td><code>{s}</code></td>
                  <td className={f ? 'yes' : 'no'}>{f ? <ICheck label="yes" /> : '—'}</td>
                  <td className={fin ? 'yes' : 'no'}>{fin ? <ICheck label="yes" /> : '—'}</td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Full transition rules and diagrams: <a href={href('how', 'statuses')}>How it works → Statuses</a>.</p>
      </Sec>

      <Sec id="error-codes" title="Error codes">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Code</th><th>HTTP</th><th>When</th></tr></thead>
            <tbody>
              {ERROR_CODES.map(([c, h, d]) => (
                <tr key={c}><td><code>{c}</code></td><td className="mono">{h}</td><td><Rich text={d} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>
    </DocShell>
  );
}
