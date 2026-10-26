import { useEffect, useState } from 'react';
import { ErrorBox, Field, StatusBadge, TotpInput, fmtDate, short, useAction, useLoad } from '../../dashboard/src/ui';
import { RISK_FLAGS, api, totpHeader, type AuditRow, type FeeTopup, type Invoice, type Merchant, type MerchantDetail as MerchantData, type Page, type Registry as RegistryData } from './api';

/** First page of a list, plus "load more" via the server cursor. Refetches when `path` changes. */
interface Paged<T> {
  rows: T[];
  next: string | null;
  load: (after?: string) => Promise<void>;
  busy: boolean;
  error: string | undefined;
}

function usePaged<T>(path: string): Paged<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const a = useAction();
  const load = (after?: string) =>
    a.run(async () => {
      const p = await api<Page<T>>('GET', after ? `${path}&starting_after=${after}` : path);
      setRows((r) => (after ? [...r, ...p.data] : p.data));
      setNext(p.next_cursor);
    });
  useEffect(() => {
    void load();
  }, [path]); // load is recreated every render; path is the only input
  return { rows, next, load, busy: a.busy, error: a.error };
}

function More(props: { next: string | null; busy: boolean; load: (after: string) => Promise<void> }) {
  const { next } = props;
  return next ? (
    <button type="button" className="secondary" disabled={props.busy} onClick={() => { void props.load(next); }}>
      Load more
    </button>
  ) : null;
}

/** Every admin change carries an audited reason. `totp`: the action lowers a safety control and needs a fresh code. */
function ReasonAction(props: { label: string; totp?: boolean; danger?: boolean; onSubmit: (reason: string, headers: Record<string, string>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  if (!open) {
    return (
      <button type="button" className={props.danger ? 'danger' : 'secondary'} onClick={() => { setOpen(true); }}>
        {props.label}
      </button>
    );
  }
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await props.onSubmit(reason.trim(), props.totp ? totpHeader(code) : {});
          setOpen(false);
          setReason('');
          setCode('');
        });
      }}
    >
      <Field label="Reason" hint="Recorded in the audit log.">
        <input value={reason} onChange={(e) => { setReason(e.target.value); }} minLength={3} maxLength={500} required autoFocus />
      </Field>
      {props.totp && <TotpInput value={code} onChange={setCode} />}
      <ErrorBox error={a.error} />
      <div className="row">
        <button disabled={a.busy} className={props.danger ? 'danger' : ''}>{props.label}</button>
        <button type="button" className="secondary" onClick={() => { setOpen(false); }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const go = (hash: string) => () => {
  location.hash = hash;
};
const label = (s: string) => s.replace(/_/g, ' ');

// ---------------------------------------------------------------- merchants

export function Merchants() {
  const [form, setForm] = useState({ q: '', status: '', flag: '' });
  const [filters, setFilters] = useState(form);
  const qs = new URLSearchParams(Object.entries({ limit: '50', ...filters }).filter(([, v]) => v !== '')).toString();
  const p = usePaged<Merchant>(`/merchants?${qs}`);
  return (
    <section>
      <header className="page-head">
        <h2>Merchants</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(form);
          }}
        >
          <input placeholder="Name, merchant id or user email" value={form.q} onChange={(e) => { setForm({ ...form, q: e.target.value }); }} aria-label="Search" />
          <select value={form.status} onChange={(e) => { setForm({ ...form, status: e.target.value }); }} aria-label="Status">
            <option value="">Any status</option>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
          </select>
          <select value={form.flag} onChange={(e) => { setForm({ ...form, flag: e.target.value }); }} aria-label="Risk flag">
            <option value="">Any risk flag</option>
            {RISK_FLAGS.map((f) => (
              <option key={f} value={f}>{label(f)}</option>
            ))}
          </select>
          <button>Search</button>
        </form>
      </header>
      <ErrorBox error={p.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Status</th><th>Risk flags</th><th>Custody</th><th>Fee</th><th>Created</th></tr>
          </thead>
          <tbody>
            {p.rows.map((m) => (
              <tr key={m.id} className="clickable" onClick={go(`#/merchants/${m.id}`)}>
                <td><a href={`#/merchants/${m.id}`}>{m.name}</a></td>
                <td><StatusBadge status={m.status} /></td>
                <td>{m.risk_flags.map(label).join(', ') || '—'}</td>
                <td>{label(m.custody_mode)}</td>
                <td className="num">{m.fee_bps} bps</td>
                <td>{fmtDate(m.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More next={p.next} busy={p.busy} load={p.load} />
    </section>
  );
}

function RiskFlags(props: { merchant: MerchantData; onSaved: () => void }) {
  const [flags, setFlags] = useState(props.merchant.risk_flags);
  return (
    <fieldset className="scopes card">
      <legend>Risk flags</legend>
      <p className="muted">Internal markers, never shown to the merchant. Payouts frozen is enforced once custodial payouts exist.</p>
      {RISK_FLAGS.map((f) => (
        <label key={f} className="check">
          <input
            type="checkbox"
            checked={flags.includes(f)}
            onChange={(e) => {
              setFlags(e.target.checked ? [...flags, f] : flags.filter((x) => x !== f));
            }}
          />
          {label(f)}
        </label>
      ))}
      <div>
        <ReasonAction
          label="Save risk flags"
          onSubmit={async (reason) => {
            await api('PUT', `/merchants/${props.merchant.id}/risk-flags`, { flags, reason });
            props.onSaved();
          }}
        />
      </div>
    </fieldset>
  );
}

/** Fee model and fee-balance grace (D-076). Applies to invoices created afterwards. */
function FeeSettings(props: { merchant: MerchantData; onSaved: () => void }) {
  const [bps, setBps] = useState(String(props.merchant.fee_bps));
  const [fixed, setFixed] = useState(props.merchant.fee_fixed);
  const [grace, setGrace] = useState(props.merchant.fee_grace);
  return (
    <fieldset className="card">
      <legend>Fees</legend>
      <p className="muted">Fee = rate × amount + fixed, never more than the amount. Live invoices need prepaid fees above minus the grace.</p>
      <div className="row">
        <Field label="Rate (bps)"><input type="number" min={0} max={10000} value={bps} onChange={(e) => { setBps(e.target.value); }} /></Field>
        <Field label="Fixed per invoice (token units)"><input value={fixed} onChange={(e) => { setFixed(e.target.value); }} inputMode="decimal" /></Field>
        <Field label="Grace (token units)"><input value={grace} onChange={(e) => { setGrace(e.target.value); }} inputMode="decimal" /></Field>
      </div>
      <ReasonAction
        label="Save fees"
        totp
        onSubmit={async (reason, h) => {
          await api('PUT', `/merchants/${props.merchant.id}/fees`, { fee_bps: Number(bps), fee_fixed: fixed.trim(), fee_grace: grace.trim(), reason }, h);
          props.onSaved();
        }}
      />
    </fieldset>
  );
}

/** Prepaid fee top-ups: record one after the merchant paid, and the history. */
function FeeTopups(props: { merchantId: string; manage: boolean; onSaved: () => void }) {
  const [livemode, setLivemode] = useState(true);
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const list = useLoad(() => api<{ data: FeeTopup[] }>('GET', `/merchants/${props.merchantId}/fee-topups?livemode=${String(livemode)}`), [props.merchantId, livemode]);
  return (
    <div className="card">
      <h3>Prepaid fee top-ups</h3>
      <div className="row">
        <label className="check"><input type="radio" checked={livemode} onChange={() => { setLivemode(true); }} /> live</label>
        <label className="check"><input type="radio" checked={!livemode} onChange={() => { setLivemode(false); }} /> test</label>
      </div>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Token</th><th>Amount</th><th>Reference</th></tr></thead>
          <tbody>
            {(list.data?.data ?? []).length === 0 && <tr><td colSpan={4} className="muted">None yet.</td></tr>}
            {(list.data?.data ?? []).map((t) => (
              <tr key={t.id}><td>{fmtDate(t.created_at)}</td><td>{t.token}</td><td className="num">{t.amount} {t.symbol}</td><td><code>{t.reference}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.manage && (
        <>
          <p className="muted">Record a top-up only after the payment has arrived. It cannot be edited or removed.</p>
          <div className="row">
            <Field label="Token id"><input value={token} onChange={(e) => { setToken(e.target.value); }} placeholder="bsc:usdt" /></Field>
            <Field label="Amount"><input value={amount} onChange={(e) => { setAmount(e.target.value); }} inputMode="decimal" /></Field>
            <Field label="Reference" hint="Transaction hash or bank reference."><input value={reference} onChange={(e) => { setReference(e.target.value); }} /></Field>
          </div>
          <ReasonAction
            label={`Record ${livemode ? 'live' : 'test'} top-up`}
            totp
            onSubmit={async (reason, h) => {
              await api('POST', `/merchants/${props.merchantId}/fee-topups`, { livemode, token: token.trim(), amount: amount.trim(), reference: reference.trim(), reason }, h);
              setAmount('');
              setReference('');
              list.reload();
              props.onSaved();
            }}
          />
        </>
      )}
    </div>
  );
}

export function MerchantDetail(props: { id: string; manage: boolean }) {
  const m = useLoad(() => api<MerchantData>('GET', `/merchants/${props.id}`), [props.id]);
  if (m.error) return <ErrorBox error={m.error} />;
  if (!m.data) return <p className="muted">Loading…</p>;
  const d = m.data;
  const balances = d.balances.flatMap((b) => b.data.map((x) => ({ ...x, livemode: b.livemode })));
  return (
    <section>
      <p><a href="#/merchants">← Merchants</a></p>
      <h2>{d.name} <StatusBadge status={d.status} /></h2>
      <dl className="details card">
        <dt>Merchant id</dt><dd><code>{d.id}</code></dd>
        <dt>Custody mode</dt><dd>{label(d.custody_mode)}</dd>
        <dt>Platform fee</dt><dd>{d.fee_bps} bps + {d.fee_fixed} fixed · grace {d.fee_grace}</dd>
        <dt>Underpay tolerance</dt><dd>{d.underpay_tolerance_bps} bps</dd>
        <dt>Risk flags</dt><dd>{d.risk_flags.map(label).join(', ') || '—'}</dd>
        <dt>Created</dt><dd>{fmtDate(d.created_at)}</dd>
      </dl>
      <div className="row">
        <a href={`#/invoices?merchant=${d.id}`}>Invoices needing a decision</a>
        <a href={`#/audit?merchant=${d.id}`}>Audit log</a>
      </div>
      {props.manage && (
        <div className="card">
          <h3>Status</h3>
          {d.status === 'active' ? (
            <>
              <p className="muted">Suspending stops the merchant's API keys and every new invoice and payment link at once.</p>
              <ReasonAction label="Suspend merchant" danger onSubmit={async (reason) => { await api('POST', `/merchants/${d.id}/suspend`, { reason }); m.reload(); }} />
            </>
          ) : (
            <ReasonAction label="Reactivate merchant" totp onSubmit={async (reason, h) => { await api('POST', `/merchants/${d.id}/reactivate`, { reason }, h); m.reload(); }} />
          )}
        </div>
      )}
      {props.manage && <RiskFlags merchant={d} onSaved={m.reload} />}
      {props.manage && <FeeSettings merchant={d} onSaved={m.reload} />}

      <h3>Balances</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Mode</th><th>Token</th><th>Received</th><th>Fees charged</th><th>Prepaid fees</th><th>Fee status</th></tr>
          </thead>
          <tbody>
            {balances.length === 0 && (
              <tr><td colSpan={6} className="muted">No payments yet.</td></tr>
            )}
            {balances.map((b) => (
              <tr key={`${String(b.livemode)}:${b.token}`}>
                <td>{b.livemode ? 'live' : 'test'}</td>
                <td>{b.token}</td>
                <td className="num">{b.received} {b.symbol}</td>
                <td className="num">{b.fees_charged} {b.symbol}</td>
                <td className="num">{b.prepaid_fees} {b.symbol}</td>
                <td>{label(b.fee_status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <FeeTopups merchantId={d.id} manage={props.manage} onSaved={m.reload} />

      <h3>Users</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Email</th><th>Role</th><th>2FA</th><th>Locked until</th><th></th></tr>
          </thead>
          <tbody>
            {d.users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.totp_enabled ? 'on' : 'off'}</td>
                <td>{fmtDate(u.locked_until)}</td>
                <td>
                  {props.manage && u.totp_enabled && (
                    <ReasonAction label="Reset 2FA" totp danger onSubmit={async (reason, h) => { await api('POST', `/merchants/${d.id}/users/${u.id}/reset-2fa`, { reason }, h); m.reload(); }} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.manage && (
        <p className="muted">Reset 2FA only after verifying the user's identity out of band: afterwards the password alone signs in.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- invoices

const STATUSES = ['underpaid', 'late_payment', 'paid', 'overpaid', 'settled', 'pending', 'detected', 'confirming', 'expired', 'cancelled', 'failed'];

export function Invoices(props: { merchantId?: string | undefined }) {
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams(Object.entries({ limit: '50', status, merchant_id: props.merchantId ?? '' }).filter(([, v]) => v !== '')).toString();
  const p = usePaged<Invoice>(`/invoices?${qs}`);
  return (
    <section>
      <header className="page-head">
        <h2>Invoices</h2>
        <select value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Status">
          <option value="">Needs a decision (underpaid, late payment)</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </select>
      </header>
      {props.merchantId && <p className="muted">Merchant <code>{props.merchantId}</code> · <a href="#/invoices">all merchants</a></p>}
      <ErrorBox error={p.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Created</th><th>Merchant</th><th>Status</th><th>Expected</th><th>Received</th><th>Mode</th></tr>
          </thead>
          <tbody>
            {p.rows.length === 0 && !p.busy && (
              <tr><td colSpan={6} className="muted">Nothing here.</td></tr>
            )}
            {p.rows.map((i) => (
              <tr key={i.id} className="clickable" onClick={go(`#/invoices/${i.id}`)}>
                <td><a href={`#/invoices/${i.id}`}>{fmtDate(i.created_at)}</a></td>
                <td>{i.merchant_name}</td>
                <td><StatusBadge status={i.status} /></td>
                <td className="num">{i.amount} {i.symbol}</td>
                <td className="num">{i.amount_received} {i.symbol}</td>
                <td>{i.livemode ? 'live' : 'test'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More next={p.next} busy={p.busy} load={p.load} />
    </section>
  );
}

export function InvoiceDetail(props: { id: string; manage: boolean }) {
  const inv = useLoad(() => api<Invoice>('GET', `/invoices/${props.id}`), [props.id]);
  if (inv.error) return <ErrorBox error={inv.error} />;
  if (!inv.data) return <p className="muted">Loading…</p>;
  const i = inv.data;
  const resolvable = i.status === 'underpaid' || i.status === 'late_payment';
  return (
    <section>
      <p><a href="#/invoices">← Invoices</a></p>
      <h2>Invoice <StatusBadge status={i.status} /></h2>
      <dl className="details card">
        <dt>Invoice id</dt><dd><code>{i.id}</code></dd>
        <dt>Merchant</dt><dd><a href={`#/merchants/${i.merchant_id}`}><code>{i.merchant_id}</code></a></dd>
        <dt>Mode</dt><dd>{i.livemode ? 'live' : 'test'} · {label(i.custody_mode)}</dd>
        <dt>Expected</dt><dd className="num">{i.amount} {i.symbol} on {i.network}</dd>
        <dt>Received</dt><dd className="num">{i.amount_received} {i.symbol}</dd>
        <dt>Platform fee</dt><dd className="num">{i.fee_amount ?? '—'}</dd>
        <dt>Deposit address</dt><dd><code>{i.deposit_address}</code></dd>
        <dt>Order id</dt><dd>{i.external_order_id ?? '—'}</dd>
        <dt>Expires</dt><dd>{fmtDate(i.expires_at)}</dd>
      </dl>
      {props.manage && resolvable && (
        <div className="card">
          <h3>Manual resolution</h3>
          <p className="warning">
            Marks the invoice paid with what arrived ({i.amount_received} of {i.amount} {i.symbol}). The platform fee is charged on that
            amount, the merchant gets <code>invoice.paid</code>, and the invoice settles. This cannot be undone.
          </p>
          <ReasonAction label="Mark as paid" totp danger onSubmit={async (reason, h) => { await api('POST', `/invoices/${i.id}/resolve`, { reason }, h); inv.reload(); }} />
        </div>
      )}
      <h3>Payments</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Tx</th><th>From</th><th>Amount</th><th>Status</th><th>Block</th><th>Block time</th></tr>
          </thead>
          <tbody>
            {(i.payments ?? []).map((p) => (
              <tr key={p.tx_hash}>
                <td><code>{short(p.tx_hash)}</code></td>
                <td><code>{short(p.from)}</code></td>
                <td className="num">{p.amount}</td>
                <td><StatusBadge status={p.status} /></td>
                <td className="num">{p.block_number}</td>
                <td>{fmtDate(p.block_time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>History</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>At</th><th>From</th><th>To</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {(i.history ?? []).map((h) => (
              <tr key={`${h.at}:${h.to}`}>
                <td>{fmtDate(h.at)}</td>
                <td>{h.from ? label(h.from) : '—'}</td>
                <td>{label(h.to)}</td>
                <td>{h.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- kill switches

export function Registry(props: { manage: boolean; superadmin: boolean }) {
  const r = useLoad(() => api<RegistryData>('GET', '/registry'), []);
  const toggle = (kind: 'chain' | 'token', id: string, enabled: boolean) => {
    if (!props.manage) return null;
    if (enabled) {
      return <ReasonAction label="Disable" danger onSubmit={async (reason) => { await api('POST', `/registry/${kind}/${id}/disable`, { reason }); r.reload(); }} />;
    }
    if (!props.superadmin) return <span className="muted">superadmin can re-enable</span>;
    return <ReasonAction label="Enable" totp onSubmit={async (reason, h) => { await api('POST', `/registry/${kind}/${id}/enable`, { reason }, h); r.reload(); }} />;
  };
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h2>Kill switches</h2>
      <p className="notice">
        Disabling a chain or token stops new invoices and payment-link checkouts on it immediately. Running watchers keep recording
        payments to existing invoices until they are restarted.
      </p>
      <h3>Chains</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Chain</th><th>Network</th><th>Enabled</th><th></th></tr>
          </thead>
          <tbody>
            {r.data.chains.map((c) => (
              <tr key={c.id}>
                <td><code>{c.id}</code> {c.name}</td>
                <td>{c.testnet ? 'testnet' : 'mainnet'}</td>
                <td>{c.enabled ? 'yes' : 'no'}</td>
                <td>{toggle('chain', c.id, c.enabled)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Tokens</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Token</th><th>Chain</th><th>Enabled</th><th></th></tr>
          </thead>
          <tbody>
            {r.data.tokens.map((t) => (
              <tr key={t.id}>
                <td><code>{t.id}</code> {t.symbol}</td>
                <td>{t.chain_id}</td>
                <td>{t.enabled ? 'yes' : 'no'}</td>
                <td>{toggle('token', t.id, t.enabled)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- audit log

export function Audit(props: { merchantId?: string | undefined }) {
  const [form, setForm] = useState({ merchant_id: props.merchantId ?? '', action: '', actor_id: '' });
  const [filters, setFilters] = useState(form);
  const qs = new URLSearchParams(Object.entries({ limit: '50', ...filters }).filter(([, v]) => v.trim() !== '')).toString();
  const p = usePaged<AuditRow>(`/audit-logs?${qs}`);
  const verify = useAction();
  const [chain, setChain] = useState<string>();
  return (
    <section>
      <header className="page-head">
        <h2>Audit log</h2>
        <div className="row">
          {chain && <span className={chain.startsWith('intact') ? 'muted' : 'error'}>{chain}</span>}
          <button
            type="button"
            className="secondary"
            disabled={verify.busy}
            onClick={() => {
              void verify.run(async () => {
                const r = await api<{ intact: boolean; first_bad_seq: string | null }>('GET', '/audit-logs/verify');
                setChain(r.intact ? `intact (checked ${new Date().toLocaleTimeString()})` : `BROKEN at seq ${r.first_bad_seq ?? '?'}: security incident, see RUNBOOK`);
              });
            }}
          >
            Verify hash chain
          </button>
        </div>
      </header>
      <ErrorBox error={verify.error} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(form);
        }}
      >
        <input placeholder="Merchant id" value={form.merchant_id} onChange={(e) => { setForm({ ...form, merchant_id: e.target.value }); }} aria-label="Merchant id" />
        <input placeholder="Action prefix, e.g. admin." value={form.action} onChange={(e) => { setForm({ ...form, action: e.target.value }); }} aria-label="Action prefix" />
        <input placeholder="Actor id" value={form.actor_id} onChange={(e) => { setForm({ ...form, actor_id: e.target.value }); }} aria-label="Actor id" />
        <button>Filter</button>
      </form>
      <ErrorBox error={p.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Seq</th><th>At</th><th>Actor</th><th>Action</th><th>Target</th><th>Merchant</th><th>Details</th></tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.seq}>
                <td className="num">{r.seq}</td>
                <td>{fmtDate(r.at)}</td>
                <td>{r.actor_type} {r.actor_id && <code>{short(r.actor_id, 4)}</code>}</td>
                <td>{r.action}</td>
                <td>{r.target_type} {r.target_id && <code>{short(r.target_id, 4)}</code>}</td>
                <td>{r.merchant_id && <a href={`#/merchants/${r.merchant_id}`}><code>{short(r.merchant_id, 4)}</code></a>}</td>
                <td><code>{r.after === null ? '' : JSON.stringify(r.after).slice(0, 120)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More next={p.next} busy={p.busy} load={p.load} />
    </section>
  );
}
