import { useState, type ReactNode } from 'react';
import { Callout, SectionHead } from '../ui/bits';
import {
  IActivity, IAlert, IBranch, ICheck, IClock, ICpu, IDatabase, IEye, IFingerprint, IGauge, IHistory, IKey, ILayers, ILock, IRefresh,
  IScale, IServer, IUsers, IWallet, IWebhook,
} from '../ui/icons';
import { CtaBand, PageHero } from './How';

const LAYERS: { id: string; name: string; text: string }[] = [
  { id: 'l1', name: 'Your app', text: 'Secret key on your server · verified webhooks' },
  { id: 'l2', name: 'API', text: 'Scoped keys · 2FA step-up · rate limits · RLS tenant isolation' },
  { id: 'l3', name: 'Ledger & database', text: 'Balanced append-only journals · state machine triggers · limits' },
  { id: 'l4', name: 'Signer', text: 'Isolated process · own DB role · re-checks every intent' },
  { id: 'l5', name: 'Blockchain', text: 'Finality · reorg handling · hourly reconciliation' },
];

function Stack() {
  const [hot, setHot] = useState<string | null>(null);
  return (
    <div className="stack3d-wrap" aria-hidden="true">
      <div className={`stack3d ${hot ? 'has-hot' : ''}`}>
        {LAYERS.map((l, i) => (
          <div
            key={l.id}
            className={`slab s${String(i + 1)} ${hot === l.id ? 'hot' : ''}`}
            onPointerEnter={() => {
              setHot(l.id);
            }}
            onPointerLeave={() => {
              setHot(null);
            }}
          >
            <div className="slab-face">
              <b>{l.name}</b>
              <span>{l.text}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="stack-shadow" />
    </div>
  );
}

interface Control { icon: ReactNode; tone: string; title: string; items: string[] }
const CONTROLS: Control[] = [
  {
    icon: <ILock />, tone: '', title: 'Keys and signing',
    items: [
      'Keys live only in the signer: its own process, its own database role, reachable by mTLS from the worker only.',
      'The signer accepts intents, not transactions: it re-derives addresses and re-checks every payout against the ledger and your limits before signing.',
      'One transaction per intent, a per-sender lock, and a kill switch that makes the signer refuse everything.',
      'App servers hold xpubs only. In forwarder mode nobody holds a key at all.',
    ],
  },
  {
    icon: <IScale />, tone: 'amber', title: 'Ledger and reconciliation',
    items: [
      'Money is integer minor units in code and NUMERIC(78,0) in the database. Floats are banned by lint.',
      'Every movement is a balanced, double-entry journal. Triggers reject unbalanced, edited or deleted entries.',
      'Payment, invoice status, ledger and outgoing event are written in one transaction.',
      'An independent reconciliation re-checks the ledger against payments and the chain every hour.',
    ],
  },
  {
    icon: <IGauge />, tone: 'blue', title: 'Payout controls',
    items: [
      'Your one-time and daily limits are enforced three times: in the app, in the database and in the signer.',
      'Live payouts need limits; changing them needs 2FA and is audited.',
      'Never to a gateway address or a blocked address; destinations are EIP-55 checked.',
      'Merchant withdrawals above a threshold need two different admins to approve.',
    ],
  },
  {
    icon: <IFingerprint />, tone: 'violet', title: 'Accounts and access',
    items: [
      'Two-factor authentication; a fresh code (used once) for every sensitive action: API keys, webhooks, payout addresses, limits, team.',
      'Five roles from owner to read-only; API keys scoped per capability, with optional IP allowlist and expiry.',
      'Short-lived session tokens with refresh cookies, CSRF tokens and an allowlisted Origin.',
      'A hash-chained, append-only audit log you can verify end to end.',
    ],
  },
  {
    icon: <IWebhook />, tone: 'teal', title: 'Webhooks',
    items: [
      'HMAC-SHA256 over the timestamp and raw body; a 5-minute tolerance stops replays.',
      'Secrets rotate with an overlap window: old and new both sign until it ends.',
      'SSRF guard: private, loopback and link-local destinations are refused, redirects are not followed.',
      'Signing secrets are shown once and stored encrypted.',
    ],
  },
  {
    icon: <IWallet />, tone: 'red', title: 'Addresses and changes',
    items: [
      'Each address serves one owner forever: unique indexes and immutability triggers in the database.',
      'Seed phrases and private keys pasted as an xpub are detected and refused; live xpubs need an ownership signature.',
      'A new live payout address or xpub activates after 24 hours, and every owner is emailed.',
      'Custody mode locks after the first live invoice.',
    ],
  },
];

const RISK: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <IAlert />, title: 'Risk holds', text: 'Payments from blocked payers or above live limits are held for review: paid, but not released until an admin decides.' },
  { icon: <IEye />, title: 'Blocked addresses', text: 'A platform list of addresses that can never receive a payout; payments from them are held for review.' },
  { icon: <IActivity />, title: 'Kill switches', text: 'Disable a chain, a token or the signer instantly; re-enabling needs a higher role and 2FA.' },
  { icon: <IHistory />, title: 'Everything audited', text: 'Admin actions require a reason and land in the same tamper-evident log.' },
];

const ROLES: [string, boolean, boolean, boolean, boolean, boolean][] = [
  ['View invoices, account', true, true, true, true, true],
  ['Reports and exports', true, true, false, true, true],
  ['Create invoices', true, true, true, true, false],
  ['API keys, webhooks', true, true, true, false, false],
  ['Refunds', true, true, false, true, false],
  ['Request withdrawals', true, false, false, true, false],
  ['Payout limits, custody', true, false, false, false, false],
  ['Team, settings, audit log', true, true, false, false, false],
];

export function Security() {
  return (
    <>
      <PageHero
        page="security"
        eyebrow="Security"
        title={<>Defense in depth, <span className="grad-text">by design.</span></>}
        lead="Every control that guards money exists in more than one layer, so a bug in one is caught by the next. Here is what each layer does."
        chips={[['controls', 'Controls'], ['risk', 'Risk'], ['availability', 'Availability'], ['roles', 'Roles']]}
        aside={<Stack />}
      />

      <section className="section" id="controls">
        <div className="container">
          <SectionHead eyebrow="Controls" title="What stands between a bug and your money." />
          <div className="grid g2 controls">
            {CONTROLS.map((c, i) => (
              <article key={c.title} className={`card spot control reveal d${String((i % 2) + 1)}`}>
                <div className="control-head">
                  <span className={`ico-wrap ${c.tone}`}>{c.icon}</span>
                  <h3>{c.title}</h3>
                </div>
                <ul className="checks">
                  {c.items.map((it) => (
                    <li key={it}><ICheck /><span>{it}</span></li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section alt" id="risk">
        <div className="container">
          <SectionHead eyebrow="Risk" title="Controls the platform operates for you." lead="Separate admin console, separate origin, password + TOTP on every login." />
          <div className="grid g4">
            {RISK.map((r, i) => (
              <div key={r.title} className={`mini reveal d${String(i + 1)}`}>
                <span className="mini-ico">{r.icon}</span>
                <h4>{r.title}</h4>
                <p>{r.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="availability">
        <div className="container">
          <SectionHead eyebrow="Availability" title="Built to fail safely." lead="Postgres is the only durable state. Everything else can restart, fail over or be rebuilt." />
          <div className="avail reveal">
            <div className="avail-item"><ILayers /><b>api</b><span>2+ stateless instances; Redis down means rate limits fail open, the rest works.</span></div>
            <div className="avail-item"><IRefresh /><b>worker</b><span>2+; jobs claimed with SKIP LOCKED, each scheduled job runs once.</span></div>
            <div className="avail-item"><IBranch /><b>watcher</b><span>Leader + standby per chain; takeover in about 5 s, fenced against stale writes.</span></div>
            <div className="avail-item"><ICpu /><b>signer</b><span>One active; sweeps and payouts wait and resume, incoming payments are unaffected.</span></div>
            <div className="avail-item"><IDatabase /><b>Postgres</b><span>Synchronous replica + WAL archive: no committed money write is lost.</span></div>
            <div className="avail-item"><IClock /><b>Recovery</b><span>Target: back within 30 minutes with a manual failover.</span></div>
          </div>
        </div>
      </section>

      <section className="section alt" id="roles">
        <div className="container">
          <SectionHead eyebrow="Roles" title="Least privilege for your team." lead="Invite teammates with a role; changing roles and removing members needs 2FA and signs them out." />
          <div className="table-wrap reveal">
            <table className="t roles">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>Owner</th>
                  <th>Admin</th>
                  <th>Developer</th>
                  <th>Finance</th>
                  <th>Read-only</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map(([name, ...cells]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    {cells.map((c, i) => (
                      <td key={String(i)} className={c ? 'yes' : 'no'}>{c ? <ICheck label="yes" /> : <span aria-label="no">—</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid g3 sec-notes">
            <div className="mini reveal"><span className="mini-ico"><IKey /></span><h4>API key scopes</h4><p><code>read</code>, <code>invoices:write</code>, <code>payouts:write</code>, <code>refunds:write</code>, <code>webhooks:write</code>. Withdrawing your own balance is dashboard-only: no key can do it.</p></div>
            <div className="mini reveal d1"><span className="mini-ico"><IUsers /></span><h4>Invitations</h4><p>Seven-day invite links; admins can invite developer, finance and read-only members.</p></div>
            <div className="mini reveal d2"><span className="mini-ico"><IServer /></span><h4>Tenant isolation</h4><p>Row-level security in Postgres: every query runs in its merchant's context.</p></div>
          </div>
          <Callout kind="ok">
            <strong>Live mode on BSC mainnet opens after an independent security audit.</strong> Test mode on BSC testnet is available today, with the
            same code paths. Every money-moving file is listed for mandatory human review and held to a 90% coverage gate.
          </Callout>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
