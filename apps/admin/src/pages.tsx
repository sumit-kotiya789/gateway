import { useEffect, useState } from 'react';
import { Alert, CopyField, EmptyState, ErrorBox, Field, Icon, Modal, Skeleton, StatusBadge, Submit, TotpInput, fmtDate, short, toast, useAction, useLoad, type IconName } from '../../dashboard/src/ui';
import { RISK_FLAGS, api, totpHeader, type AdminAccount, type AdminCredentials, type AdminRole, type AuditRow, type FeeTopup, type Invoice, type Merchant, type MerchantDetail as MerchantData, type Page, type Registry as RegistryData } from './api';

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
    <div className="more">
      <button type="button" className="secondary" disabled={props.busy} onClick={() => { void props.load(next); }}>
        {props.busy && <Icon name="loader" className="spin" size={16} />}
        Load more
      </button>
    </div>
  ) : null;
}

/** Table body states shared by the paged lists: skeleton on first load, empty state when nothing matched. */
function ListState(props: { busy: boolean; count: number; icon: IconName; empty: string; children?: string }) {
  if (props.count > 0) return null;
  if (props.busy) return <Skeleton />;
  return <EmptyState icon={props.icon} title={props.empty}>{props.children}</EmptyState>;
}

const Back = (props: { href: string; children: string }) => (
  <a className="back" href={props.href}>
    <Icon name="back" size={16} />
    {props.children}
  </a>
);

const OnOff = (props: { on: boolean; yes: string; no: string }) => <span className={props.on ? 'badge s-active' : 'badge s-cancelled'}>{props.on ? props.yes : props.no}</span>;

/** Every admin change carries an audited reason. `totp`: the action lowers a safety control and needs a fresh code. */
function ReasonAction(props: {
  label: string;
  totp?: boolean;
  danger?: boolean;
  primary?: boolean;
  sm?: boolean;
  /** What the action does, shown in the dialog. */
  message?: string;
  onSubmit: (reason: string, headers: Record<string, string>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  const close = () => {
    setOpen(false);
    setReason('');
    setCode('');
  };
  const trigger = [props.danger ? 'danger-outline' : props.primary ? '' : 'secondary', props.sm ? 'sm' : ''].join(' ').trim();
  return (
    <>
      <button type="button" className={trigger} onClick={() => { setOpen(true); }}>
        {props.label}
      </button>
      {open && (
        <Modal title={props.label} icon={props.danger ? 'alert' : props.totp ? 'lock' : 'shield'} onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await props.onSubmit(reason.trim(), props.totp ? totpHeader(code) : {});
                close();
                toast.success(`${props.label}: done`, 'Recorded in the audit log.');
              });
            }}
          >
            {props.message && <p>{props.message}</p>}
            <Field label="Reason" hint="Recorded in the audit log.">
              <input value={reason} onChange={(e) => { setReason(e.target.value); }} minLength={3} maxLength={500} placeholder="Ticket or short explanation" required data-autofocus />
            </Field>
            {props.totp && <TotpInput value={code} onChange={setCode} />}
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={close}>
                Cancel
              </button>
              <Submit busy={a.busy} className={props.danger ? 'danger' : ''}>{props.label}</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
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
      </header>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(form);
        }}
      >
        <input placeholder="Name, merchant id or user email" value={form.q} onChange={(e) => { setForm({ ...form, q: e.target.value }); }} aria-label="Search" />
        <select value={form.status} onChange={(e) => { setForm({ ...form, status: e.target.value }); }} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <select value={form.flag} onChange={(e) => { setForm({ ...form, flag: e.target.value }); }} aria-label="Risk flag">
          <option value="">Any risk flag</option>
          {RISK_FLAGS.map((f) => (
            <option key={f} value={f}>{label(f)}</option>
          ))}
        </select>
        <button>
          <Icon name="search" size={16} />
          Search
        </button>
      </form>
      <ErrorBox error={p.error} />
      <ListState busy={p.busy} count={p.rows.length} icon="store" empty="No merchants match">Try a different name, id or filter.</ListState>
      {p.rows.length > 0 && (
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
                  <td>{m.risk_flags.length > 0 ? m.risk_flags.map((f) => <span key={f} className="badge s-low">{label(f)}</span>) : <span className="muted">—</span>}</td>
                  <td>{label(m.custody_mode)}</td>
                  <td className="num">{m.fee_bps} bps</td>
                  <td>{fmtDate(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      <div className="card-actions">
        <ReasonAction
          label="Save risk flags"
          primary
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
      <div className="form-grid">
        <Field label="Rate (bps)"><input type="number" min={0} max={10000} value={bps} onChange={(e) => { setBps(e.target.value); }} /></Field>
        <Field label="Fixed per invoice (token units)"><input value={fixed} onChange={(e) => { setFixed(e.target.value); }} inputMode="decimal" /></Field>
        <Field label="Grace (token units)"><input value={grace} onChange={(e) => { setGrace(e.target.value); }} inputMode="decimal" /></Field>
      </div>
      <div className="card-actions">
        <ReasonAction
          label="Save fees"
          totp
          primary
          onSubmit={async (reason, h) => {
            await api('PUT', `/merchants/${props.merchant.id}/fees`, { fee_bps: Number(bps), fee_fixed: fixed.trim(), fee_grace: grace.trim(), reason }, h);
            props.onSaved();
          }}
        />
      </div>
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
      <header className="card-head">
        <h3>Prepaid fee top-ups</h3>
        <div className="mode" role="group" aria-label="Mode">
          <button type="button" className={livemode ? 'on' : ''} aria-pressed={livemode} onClick={() => { setLivemode(true); }}>Live</button>
          <button type="button" className={livemode ? '' : 'on'} aria-pressed={!livemode} onClick={() => { setLivemode(false); }}>Test</button>
        </div>
      </header>
      <ErrorBox error={list.error} />
      {(list.data?.data ?? []).length === 0 ? (
        <p className="muted">{list.data ? `No ${livemode ? 'live' : 'test'} top-ups yet.` : 'Loading…'}</p>
      ) : (
        <div className="table-wrap flat">
          <table>
            <thead><tr><th>Date</th><th>Token</th><th>Amount</th><th>Reference</th></tr></thead>
            <tbody>
              {(list.data?.data ?? []).map((t) => (
                <tr key={t.id}><td>{fmtDate(t.created_at)}</td><td>{t.token}</td><td className="num">{t.amount} {t.symbol}</td><td><code>{t.reference}</code></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.manage && (
        <>
          <h4>Record a top-up</h4>
          <p className="muted">Only after the payment has arrived. It cannot be edited or removed.</p>
          <div className="form-grid">
            <Field label="Token id"><input value={token} onChange={(e) => { setToken(e.target.value); }} placeholder="bsc:usdt" /></Field>
            <Field label="Amount"><input value={amount} onChange={(e) => { setAmount(e.target.value); }} inputMode="decimal" /></Field>
            <Field label="Reference" hint="Transaction hash or bank reference."><input value={reference} onChange={(e) => { setReference(e.target.value); }} /></Field>
          </div>
          <div className="card-actions">
            <ReasonAction
              label={`Record ${livemode ? 'live' : 'test'} top-up`}
              totp
              primary
              message={`Credits ${amount.trim() || '?'} ${token.trim() || '?'} of prepaid fees (${livemode ? 'live' : 'test'} mode).`}
              onSubmit={async (reason, h) => {
                await api('POST', `/merchants/${props.merchantId}/fee-topups`, { livemode, token: token.trim(), amount: amount.trim(), reference: reference.trim(), reason }, h);
                setAmount('');
                setReference('');
                list.reload();
                props.onSaved();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function MerchantDetail(props: { id: string; manage: boolean }) {
  const m = useLoad(() => api<MerchantData>('GET', `/merchants/${props.id}`), [props.id]);
  if (m.error) return <ErrorBox error={m.error} />;
  if (!m.data) return <Skeleton />;
  const d = m.data;
  const balances = d.balances.flatMap((b) => b.data.map((x) => ({ ...x, livemode: b.livemode })));
  return (
    <section>
      <Back href="#/merchants">Merchants</Back>
      <header className="page-head">
        <h2>{d.name} <StatusBadge status={d.status} /></h2>
        <div className="row">
          <a className="btn secondary sm" href={`#/invoices?merchant=${d.id}`}><Icon name="invoice" size={16} />Invoices needing a decision</a>
          <a className="btn secondary sm" href={`#/audit?merchant=${d.id}`}><Icon name="list" size={16} />Audit log</a>
        </div>
      </header>
      <dl className="details card">
        <dt>Merchant id</dt><dd><CopyField value={d.id} /></dd>
        <dt>Custody mode</dt><dd>{label(d.custody_mode)}</dd>
        <dt>Platform fee</dt><dd>{d.fee_bps} bps + {d.fee_fixed} fixed · grace {d.fee_grace}</dd>
        <dt>Underpay tolerance</dt><dd>{d.underpay_tolerance_bps} bps</dd>
        <dt>Risk flags</dt><dd>{d.risk_flags.length > 0 ? d.risk_flags.map((f) => <span key={f} className="badge s-low">{label(f)}</span>) : '—'}</dd>
        <dt>Created</dt><dd>{fmtDate(d.created_at)}</dd>
      </dl>
      {props.manage && (
        <div className={d.status === 'active' ? 'card stepup' : 'card stepup warn'}>
          <div className="stepup-text">
            <strong>{d.status === 'active' ? 'Merchant is active' : 'Merchant is suspended'}</strong>
            <span className="muted">
              {d.status === 'active'
                ? "Suspending stops the merchant's API keys and every new invoice and payment link at once."
                : 'API keys, new invoices and payment links stay blocked until reactivated.'}
            </span>
          </div>
          {d.status === 'active' ? (
            <ReasonAction
              label="Suspend merchant"
              danger
              message="API keys stop working and no new invoices or payment-link checkouts are accepted, effective immediately."
              onSubmit={async (reason) => { await api('POST', `/merchants/${d.id}/suspend`, { reason }); m.reload(); }}
            />
          ) : (
            <ReasonAction label="Reactivate merchant" totp primary onSubmit={async (reason, h) => { await api('POST', `/merchants/${d.id}/reactivate`, { reason }, h); m.reload(); }} />
          )}
        </div>
      )}
      {props.manage && <RiskFlags merchant={d} onSaved={m.reload} />}
      {props.manage && <FeeSettings merchant={d} onSaved={m.reload} />}

      <h3 className="section-title">Balances</h3>
      {balances.length === 0 ? (
        <EmptyState icon="coins" title="No payments yet" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Mode</th><th>Token</th><th>Received</th><th>Fees charged</th><th>Prepaid fees</th><th>Fee status</th></tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={`${String(b.livemode)}:${b.token}`}>
                  <td><span className={`mode-pill ${b.livemode ? 'live' : 'test'}`}>{b.livemode ? 'live' : 'test'}</span></td>
                  <td>{b.token}</td>
                  <td className="num">{b.received} {b.symbol}</td>
                  <td className="num">{b.fees_charged} {b.symbol}</td>
                  <td className="num">{b.prepaid_fees} {b.symbol}</td>
                  <td><StatusBadge status={b.fee_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FeeTopups merchantId={d.id} manage={props.manage} onSaved={m.reload} />

      <h3 className="section-title">Users</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Email</th><th>Role</th><th>2FA</th><th>Locked until</th><th></th></tr>
          </thead>
          <tbody>
            {d.users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td className="cap">{label(u.role)}</td>
                <td><OnOff on={u.totp_enabled} yes="on" no="off" /></td>
                <td>{fmtDate(u.locked_until)}</td>
                <td>
                  {props.manage && u.totp_enabled && (
                    <ReasonAction
                      label="Reset 2FA"
                      totp
                      danger
                      sm
                      message={`Removes two-factor authentication for ${u.email}. Afterwards the password alone signs in.`}
                      onSubmit={async (reason, h) => { await api('POST', `/merchants/${d.id}/users/${u.id}/reset-2fa`, { reason }, h); m.reload(); }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.manage && (
        <Alert tone="warning">Reset 2FA only after verifying the user's identity out of band: afterwards the password alone signs in.</Alert>
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
      <ListState busy={p.busy} count={p.rows.length} icon="invoice" empty={status === '' ? 'Nothing needs a decision' : 'No invoices with this status'}>
        Underpaid and late payments show up here for manual resolution.
      </ListState>
      {p.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Created</th><th>Merchant</th><th>Status</th><th>Expected</th><th>Received</th><th>Mode</th></tr>
            </thead>
            <tbody>
              {p.rows.map((i) => (
                <tr key={i.id} className="clickable" onClick={go(`#/invoices/${i.id}`)}>
                  <td><a href={`#/invoices/${i.id}`}>{fmtDate(i.created_at)}</a></td>
                  <td>{i.merchant_name}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="num">{i.amount} {i.symbol}</td>
                  <td className="num">{i.amount_received} {i.symbol}</td>
                  <td><span className={`mode-pill ${i.livemode ? 'live' : 'test'}`}>{i.livemode ? 'live' : 'test'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <More next={p.next} busy={p.busy} load={p.load} />
    </section>
  );
}

export function InvoiceDetail(props: { id: string; manage: boolean }) {
  const inv = useLoad(() => api<Invoice>('GET', `/invoices/${props.id}`), [props.id]);
  if (inv.error) return <ErrorBox error={inv.error} />;
  if (!inv.data) return <Skeleton />;
  const i = inv.data;
  const resolvable = i.status === 'underpaid' || i.status === 'late_payment';
  return (
    <section>
      <Back href="#/invoices">Invoices</Back>
      <h2>Invoice <StatusBadge status={i.status} /></h2>
      <dl className="details card">
        <dt>Invoice id</dt><dd><CopyField value={i.id} /></dd>
        <dt>Merchant</dt><dd><a href={`#/merchants/${i.merchant_id}`}><code>{i.merchant_id}</code></a></dd>
        <dt>Mode</dt><dd>{i.livemode ? 'live' : 'test'} · {label(i.custody_mode)}</dd>
        <dt>Expected</dt><dd className="num">{i.amount} {i.symbol} on {i.network}</dd>
        <dt>Received</dt><dd className="num">{i.amount_received} {i.symbol}</dd>
        <dt>Platform fee</dt><dd className="num">{i.fee_amount ?? '—'}</dd>
        <dt>Deposit address</dt><dd><CopyField value={i.deposit_address} /></dd>
        <dt>Order id</dt><dd>{i.external_order_id ?? '—'}</dd>
        <dt>Expires</dt><dd>{fmtDate(i.expires_at)}</dd>
      </dl>
      {props.manage && resolvable && (
        <div className="card">
          <h3>Manual resolution</h3>
          <Alert tone="warning">
            Marks the invoice paid with what arrived ({i.amount_received} of {i.amount} {i.symbol}). The platform fee is charged on that
            amount, the merchant gets <code>invoice.paid</code>, and the invoice settles. This cannot be undone.
          </Alert>
          <ReasonAction
            label="Mark as paid"
            totp
            danger
            message={`Settles the invoice with ${i.amount_received} of ${i.amount} ${i.symbol}. This cannot be undone.`}
            onSubmit={async (reason, h) => { await api('POST', `/invoices/${i.id}/resolve`, { reason }, h); inv.reload(); }}
          />
        </div>
      )}
      <h3 className="section-title">Payments</h3>
      {(i.payments ?? []).length === 0 ? (
        <EmptyState icon="activity" title="No payments detected" />
      ) : (
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
      )}
      <h3 className="section-title">History</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>At</th><th>From</th><th>To</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {(i.history ?? []).map((h) => (
              <tr key={`${h.at}:${h.to}`}>
                <td>{fmtDate(h.at)}</td>
                <td>{h.from ? <StatusBadge status={h.from} /> : '—'}</td>
                <td><StatusBadge status={h.to} /></td>
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
      return (
        <ReasonAction
          label={`Disable ${id}`}
          danger
          sm
          message={`New invoices and payment-link checkouts on ${id} stop immediately.`}
          onSubmit={async (reason) => { await api('POST', `/registry/${kind}/${id}/disable`, { reason }); r.reload(); }}
        />
      );
    }
    if (!props.superadmin) return <span className="muted">superadmin can re-enable</span>;
    return <ReasonAction label={`Enable ${id}`} totp sm onSubmit={async (reason, h) => { await api('POST', `/registry/${kind}/${id}/enable`, { reason }, h); r.reload(); }} />;
  };
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Skeleton />;
  return (
    <section>
      <h2>Kill switches</h2>
      <Alert tone="warning">
        Disabling a chain or token stops new invoices and payment-link checkouts on it immediately. Running watchers keep recording
        payments to existing invoices until they are restarted.
      </Alert>
      <h3 className="section-title">Chains</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Chain</th><th>Network</th><th>Enabled</th><th></th></tr>
          </thead>
          <tbody>
            {r.data.chains.map((c) => (
              <tr key={c.id}>
                <td><code>{c.id}</code> <span className="muted">{c.name}</span></td>
                <td>{c.testnet ? 'testnet' : 'mainnet'}</td>
                <td><OnOff on={c.enabled} yes="enabled" no="disabled" /></td>
                <td>{toggle('chain', c.id, c.enabled)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="section-title">Tokens</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Token</th><th>Chain</th><th>Enabled</th><th></th></tr>
          </thead>
          <tbody>
            {r.data.tokens.map((t) => (
              <tr key={t.id}>
                <td><code>{t.id}</code> <span className="muted">{t.symbol}</span></td>
                <td>{t.chain_id}</td>
                <td><OnOff on={t.enabled} yes="enabled" no="disabled" /></td>
                <td>{toggle('token', t.id, t.enabled)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- admin accounts (superadmin)

const ADMIN_ROLES: AdminRole[] = ['superadmin', 'operator', 'auditor'];

/** New password + authenticator, shown once. The superadmin hands them over out of band. */
function CredentialsModal(props: { creds: AdminCredentials; onClose: () => void }) {
  return (
    <Modal title={`Credentials for ${props.creds.email}`} icon="lock" onClose={props.onClose}>
      <Alert tone="warning">Shown once. Hand them over in person or through your password manager, never by email or chat.</Alert>
      <Field label="Password"><CopyField value={props.creds.password} /></Field>
      <Field label="Authenticator" hint="Scan in the authenticator app, or enter the URI.">
        <img className="qr" src={`data:image/svg+xml;utf8,${encodeURIComponent(props.creds.qr_svg)}`} alt="TOTP QR code" width={200} height={200} />
      </Field>
      <CopyField value={props.creds.totp_uri} />
      <div className="row end">
        <button type="button" onClick={props.onClose}>I have handed them over</button>
      </div>
    </Modal>
  );
}

function RoleAction(props: { current: AdminRole; onSubmit: (role: AdminRole, reason: string, headers: Record<string, string>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AdminRole>(props.current);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  const close = () => {
    setOpen(false);
    setRole(props.current);
    setReason('');
    setCode('');
  };
  return (
    <>
      <button type="button" className="secondary sm" onClick={() => { setOpen(true); }}>Change role</button>
      {open && (
        <Modal title="Change role" icon="lock" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await props.onSubmit(role, reason.trim(), totpHeader(code));
                close();
                toast.success('Role changed', 'Applies to the open session at once; recorded in the audit log.');
              });
            }}
          >
            <Field label="Role">
              <select value={role} onChange={(e) => { setRole(e.target.value as AdminRole); }} data-autofocus>
                {ADMIN_ROLES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Reason" hint="Recorded in the audit log.">
              <input value={reason} onChange={(e) => { setReason(e.target.value); }} minLength={3} maxLength={500} required />
            </Field>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={close}>Cancel</button>
              <Submit busy={a.busy} disabled={role === props.current}>Change role</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function NewAdmin(props: { onCreated: (c: AdminCredentials) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'operator' as AdminRole, reason: '' });
  const [code, setCode] = useState('');
  const a = useAction();
  const close = () => {
    setOpen(false);
    setForm({ email: '', role: 'operator', reason: '' });
    setCode('');
  };
  return (
    <>
      <button type="button" className="sm" onClick={() => { setOpen(true); }}><Icon name="plus" size={16} />New admin</button>
      {open && (
        <Modal title="New admin" icon="lock" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const c = await api<AdminCredentials>('POST', '/admins/', { ...form, reason: form.reason.trim() }, totpHeader(code));
                close();
                props.onCreated(c);
              });
            }}
          >
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => { setForm({ ...form, email: e.target.value }); }} required data-autofocus /></Field>
            <Field label="Role">
              <select value={form.role} onChange={(e) => { setForm({ ...form, role: e.target.value as AdminRole }); }}>
                {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Reason" hint="Recorded in the audit log.">
              <input value={form.reason} onChange={(e) => { setForm({ ...form, reason: e.target.value }); }} minLength={3} maxLength={500} required />
            </Field>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={close}>Cancel</button>
              <Submit busy={a.busy}>Create</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Admins(props: { selfId: string }) {
  const r = useLoad(() => api<{ data: AdminAccount[] }>('GET', '/admins/'), []);
  const [creds, setCreds] = useState<AdminCredentials>();
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Skeleton />;
  return (
    <section>
      <header className="page-head">
        <h2>Admins</h2>
        <NewAdmin onCreated={(c) => { setCreds(c); r.reload(); }} />
      </header>
      <Alert tone="info">
        Disabling and role changes apply to open sessions at once. A credential reset also signs the admin out everywhere. You cannot change your
        own account here, and one active superadmin always remains.
      </Alert>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {r.data.data.map((a) => (
              <tr key={a.id}>
                <td>{a.email}{a.id === props.selfId && <span className="muted"> (you)</span>}</td>
                <td>{a.role}</td>
                <td><OnOff on={!a.disabled} yes={a.locked_until ? 'locked' : 'active'} no="disabled" /></td>
                <td>{fmtDate(a.created_at)}</td>
                <td>
                  {a.id !== props.selfId && (
                    <div className="row">
                      <RoleAction current={a.role} onSubmit={async (role, reason, h) => { await api('PUT', `/admins/${a.id}/role`, { role, reason }, h); r.reload(); }} />
                      {a.disabled ? (
                        <ReasonAction label="Enable" totp sm onSubmit={async (reason, h) => { await api('POST', `/admins/${a.id}/enable`, { reason }, h); r.reload(); }} />
                      ) : (
                        <ReasonAction label="Disable" danger sm message="Signs the admin out at once." onSubmit={async (reason) => { await api('POST', `/admins/${a.id}/disable`, { reason }); r.reload(); }} />
                      )}
                      <ReasonAction
                        label="Reset credentials"
                        totp
                        sm
                        message="New password and authenticator, shown once. The old ones and every open session stop working."
                        onSubmit={async (reason, h) => { setCreds(await api<AdminCredentials>('POST', `/admins/${a.id}/reset-credentials`, { reason }, h)); r.reload(); }}
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creds && <CredentialsModal creds={creds} onClose={() => { setCreds(undefined); }} />}
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
  const [chain, setChain] = useState<{ intact: boolean; text: string }>();
  return (
    <section>
      <header className="page-head">
        <h2>Audit log</h2>
        <button
          type="button"
          className="secondary"
          disabled={verify.busy}
          onClick={() => {
            void verify.run(async () => {
              const r = await api<{ intact: boolean; first_bad_seq: string | null }>('GET', '/audit-logs/verify');
              setChain(
                r.intact
                  ? { intact: true, text: `Hash chain intact (checked ${new Date().toLocaleTimeString()}).` }
                  : { intact: false, text: `Hash chain BROKEN at seq ${r.first_bad_seq ?? '?'}: treat as a security incident, see RUNBOOK.` },
              );
            });
          }}
        >
          <Icon name={verify.busy ? 'loader' : 'shield'} className={verify.busy ? 'spin' : ''} size={16} />
          Verify hash chain
        </button>
      </header>
      <ErrorBox error={verify.error} />
      {chain && <Alert tone={chain.intact ? 'success' : 'error'}>{chain.text}</Alert>}
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(form);
        }}
      >
        <input placeholder="Merchant id" value={form.merchant_id} onChange={(e) => { setForm({ ...form, merchant_id: e.target.value }); }} aria-label="Merchant id" />
        <input placeholder="Action prefix, e.g. admin." value={form.action} onChange={(e) => { setForm({ ...form, action: e.target.value }); }} aria-label="Action prefix" />
        <input placeholder="Actor id" value={form.actor_id} onChange={(e) => { setForm({ ...form, actor_id: e.target.value }); }} aria-label="Actor id" />
        <button>
          <Icon name="search" size={16} />
          Filter
        </button>
      </form>
      <ErrorBox error={p.error} />
      <ListState busy={p.busy} count={p.rows.length} icon="list" empty="No audit entries match" />
      {p.rows.length > 0 && (
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
      )}
      <More next={p.next} busy={p.busy} load={p.load} />
    </section>
  );
}
