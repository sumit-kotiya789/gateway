import { useEffect, useState } from 'react';
import { Amount, Asset, NetworkName, tokenOptionText } from '../../dashboard/src/asset';
import { Alert, CopyField, EmptyState, ErrorBox, Field, Icon, Modal, Skeleton, Stat, StatusBadge, Submit, TotpInput, fmtDate, short, toast, useAction, useLoad, type IconName } from '../../dashboard/src/ui';
import { RISK_FLAGS, api, totpHeader, type AdminAccount, type AdminSettings, type AdminCredentials, type AdminRole, type AdminWithdrawal, type AuditRow, type CustodyOverview, type Forward, type HotWalletPolicy, type TreasuryTransfer, type FeeTopup, type Invoice, type Merchant, type MerchantDetail as MerchantData, type Page, type Registry as RegistryData } from './api';

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
/** Token by official ticker and network from the registry, instead of typing ids like "bsc:usdt" (D-112). */
function TokenSelect(props: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const reg = useLoad(() => api<RegistryData>('GET', '/registry'), []);
  const list = reg.data?.tokens ?? [];
  return (
    <select value={props.value} onChange={(e) => { props.onChange(e.target.value); }} disabled={props.disabled} required>
      {!list.some((t) => t.id === props.value) && <option value={props.value}>{props.value || 'Choose a token'}</option>}
      {list.map((t) => <option key={t.id} value={t.id}>{tokenOptionText(t.id, t.symbol)}{t.enabled ? '' : ' (off)'}</option>)}
    </select>
  );
}

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
  const [payoutFee, setPayoutFee] = useState(props.merchant.payout_fee);
  return (
    <fieldset className="card">
      <legend>Fees</legend>
      <p className="muted">Fee = rate × amount + fixed, never more than the amount. Live invoices need prepaid fees above minus the grace.</p>
      <div className="form-grid">
        <Field label="Rate (bps)"><input type="number" min={0} max={10000} value={bps} onChange={(e) => { setBps(e.target.value); }} /></Field>
        <Field label="Fixed per invoice (token units)"><input value={fixed} onChange={(e) => { setFixed(e.target.value); }} inputMode="decimal" /></Field>
        <Field label="Grace (token units)"><input value={grace} onChange={(e) => { setGrace(e.target.value); }} inputMode="decimal" /></Field>
        <Field label="Payout fee per user payout (token units)"><input value={payoutFee} onChange={(e) => { setPayoutFee(e.target.value); }} inputMode="decimal" /></Field>
      </div>
      <div className="card-actions">
        <ReasonAction
          label="Save fees"
          totp
          primary
          onSubmit={async (reason, h) => {
            await api('PUT', `/merchants/${props.merchant.id}/fees`, { fee_bps: Number(bps), fee_fixed: fixed.trim(), fee_grace: grace.trim(), payout_fee: payoutFee.trim(), reason }, h);
            props.onSaved();
          }}
        />
      </div>
    </fieldset>
  );
}

/** Prepaid fee top-ups: record one after the merchant paid, and the history. */
function FeeTopups(props: { merchantId: string; manage: boolean; onSaved: () => void }) {
  // Live only (BNB Smart Chain mainnet); test mode is not offered.
  const livemode = true;
  const [token, setToken] = useState('bsc:usdt');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const list = useLoad(() => api<{ data: FeeTopup[] }>('GET', `/merchants/${props.merchantId}/fee-topups?livemode=${String(livemode)}`), [props.merchantId, livemode]);
  return (
    <div className="card">
      <header className="card-head">
        <h3>Prepaid fee top-ups</h3>
      </header>
      <ErrorBox error={list.error} />
      {(list.data?.data ?? []).length === 0 ? (
        <p className="muted">{list.data ? 'No top-ups yet.' : 'Loading…'}</p>
      ) : (
        <div className="table-wrap flat">
          <table>
            <thead><tr><th>Date</th><th>Token</th><th>Amount</th><th>Reference</th></tr></thead>
            <tbody>
              {(list.data?.data ?? []).map((t) => (
                <tr key={t.id}><td>{fmtDate(t.created_at)}</td><td><Asset token={t.token} symbol={t.symbol} /></td><td className="num"><Amount value={t.amount} token={t.token} symbol={t.symbol} tag={false} /></td><td><code>{t.reference}</code></td></tr>
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
            <Field label="Token"><TokenSelect value={token} onChange={setToken} /></Field>
            <Field label="Amount"><input value={amount} onChange={(e) => { setAmount(e.target.value); }} inputMode="decimal" /></Field>
            <Field label="Reference" hint="Transaction hash or bank reference."><input value={reference} onChange={(e) => { setReference(e.target.value); }} /></Field>
          </div>
          <div className="card-actions">
            <ReasonAction
              label="Record top-up"
              totp
              primary
              message={`Credits ${amount.trim() || '?'} ${token.trim() || '?'} of prepaid fees.`}
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
        <dt>Network</dt><dd>{d.network ? <NetworkName chain={d.network} /> : 'Every enabled network'} <small className="muted">(the merchant&apos;s choice)</small></dd>
        <dt>Platform fee</dt><dd>{d.fee_bps} bps + {d.fee_fixed} fixed · grace {d.fee_grace} · payout fee {d.payout_fee}</dd>
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
      <RiskLimits merchantId={d.id} manage={props.manage} />

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
                  <td><Asset token={b.token} symbol={b.symbol} /></td>
                  <td className="num">{b.received}</td>
                  <td className="num">{b.fees_charged}</td>
                  <td className="num">{b.prepaid_fees}</td>
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

const STATUSES = ['held', 'underpaid', 'late_payment', 'paid', 'overpaid', 'settled', 'pending', 'detected', 'confirming', 'expired', 'cancelled', 'failed', 'partially_paid'];

export function Invoices(props: { merchantId?: string | undefined }) {
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams(Object.entries({ limit: '50', status, merchant_id: props.merchantId ?? '' }).filter(([, v]) => v !== '')).toString();
  const p = usePaged<Invoice>(`/invoices?${qs}`);
  // Which statuses "needs a decision" covers is a console setting (D-106).
  const settings = useLoad(() => api<AdminSettings>('GET', '/settings'), []);
  const attention = (settings.data?.attention_statuses ?? []).map(label).join(', ');
  return (
    <section>
      <header className="page-head">
        <h2>Invoices</h2>
        <select value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Status">
          <option value="">{attention ? `Needs a decision (${attention})` : 'Needs a decision'}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </select>
      </header>
      {props.merchantId && <p className="muted">Merchant <code>{props.merchantId}</code> · <a href="#/invoices">all merchants</a></p>}
      <ErrorBox error={p.error} />
      <ListState busy={p.busy} count={p.rows.length} icon="invoice" empty={status === '' ? 'Nothing needs a decision' : 'No invoices with this status'}>
        {status === '' ? 'Invoices that wait for an admin show up here. Which statuses count is set in Settings.' : 'Pick another status above.'}
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
                  <td className="num"><Amount value={i.amount} token={i.token} symbol={i.symbol} /></td>
                  <td className="num"><Amount value={i.amount_received} token={i.token} symbol={i.symbol} tag={false} /></td>
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
        <dt>Expected</dt><dd className="num"><Amount value={i.amount} token={i.token} symbol={i.symbol} /></dd>
        <dt>Network</dt><dd><NetworkName chain={i.chain} label={i.network} /></dd>
        <dt>Received</dt><dd className="num"><Amount value={i.amount_received} token={i.token} symbol={i.symbol} /></dd>
        <dt>Platform fee</dt><dd className="num">{i.fee_amount ?? '—'}</dd>
        <dt>Deposit address</dt><dd><CopyField value={i.deposit_address} /></dd>
        <dt>Order id</dt><dd>{i.external_order_id ?? '—'}</dd>
        {i.sub_merchant_id && <><dt>Seller</dt><dd><code>{i.sub_merchant_id}</code></dd></>}
        <dt>Expires</dt><dd>{fmtDate(i.expires_at)}</dd>
      </dl>
      {props.manage && i.status === 'held' && (
        <div className="card">
          <h3>Risk review</h3>
          <Alert tone="warning">
            Every payment is confirmed ({i.amount_received} of {i.amount} {i.symbol}) but a risk rule held the invoice:{' '}
            {(i.history ?? []).findLast((h) => h.to === 'held')?.reason ?? 'risk review'}. Release: it becomes paid (or over- / underpaid by
            the amounts), the fee is charged and the merchant gets the event. Reject: it fails and the merchant gets{' '}
            <code>invoice.failed</code>; the funds stay where they are and any refund is handled outside the gateway.
          </Alert>
          <div className="card-actions">
            <ReasonAction
              label="Release"
              totp
              primary
              message="Releases the held payments to the merchant. This cannot be undone."
              onSubmit={async (reason, h) => { await api('POST', `/invoices/${i.id}/resolve`, { reason, action: 'release' }, h); inv.reload(); }}
            />
            <ReasonAction
              label="Reject"
              totp
              danger
              message="Fails the invoice. Any refund happens outside the gateway. This cannot be undone."
              onSubmit={async (reason, h) => { await api('POST', `/invoices/${i.id}/resolve`, { reason, action: 'reject' }, h); inv.reload(); }}
            />
          </div>
        </div>
      )}
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
                <td><NetworkName chain={c.id} label={c.name} /> <code>{c.id}</code></td>
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
                <td><Asset token={t.id} symbol={t.symbol} /> <code>{t.id}</code></td>
                <td><NetworkName chain={t.chain_id} /></td>
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

// ---------------------------------------------------------------- withdrawals (custodial)

const WITHDRAWAL_FILTERS = ['pending_approval', 'approved', 'sent', 'confirmed', 'failed', 'rejected', 'cancelled'];

/** Shown under the withdrawal queue: what to check before approving. */
function ApprovalChecklist() {
  const settings = useLoad(() => api<AdminSettings>('GET', '/settings'), []);
  const min = settings.data?.withdrawal_two_person_effective;
  const items = [
    'The merchant and the amount match its history.',
    'The payout address was not changed recently (audit log).',
    min ? `Live withdrawals of ${min} or more need two different admins.` : 'Large live withdrawals need two different admins.',
  ];
  return (
    <div className="card flat checklist">
      <h4><Icon name="shield" size={16} />Before approving</h4>
      <ul>
        {items.map((x) => (
          <li key={x}><Icon name="check" size={16} />{x}</li>
        ))}
      </ul>
    </div>
  );
}

export function WithdrawalQueue(props: { selfId: string; canApprove: boolean }) {
  const [status, setStatus] = useState('pending_approval');
  const r = useLoad(() => api<{ data: AdminWithdrawal[] }>('GET', `/withdrawals/?status=${status}`), [status]);
  return (
    <section>
      <header className="page-head">
        <h2>Withdrawals</h2>
        <select value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Status">
          {WITHDRAWAL_FILTERS.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </header>
      <ErrorBox error={r.error} />
      {!r.data && !r.error && <Skeleton />}
      {r.data?.data.length === 0 && <EmptyState icon="wallet" title="Nothing here" />}
      {r.data && r.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Requested</th><th>Merchant</th><th className="num">Amount</th><th>To</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {r.data.data.map((w) => (
                <tr key={w.id}>
                  <td>{fmtDate(w.created_at)} {w.livemode ? <span className="badge s-active">live</span> : <span className="badge">test</span>}</td>
                  <td><a href={`#/merchants/${w.merchant_id}`}>{w.merchant_name}</a></td>
                  <td className="num"><Amount value={w.amount} token={w.token} symbol={w.symbol} />{w.fee !== '0' && <small className="muted"> + fee {w.fee}</small>}</td>
                  <td>
                    <code>{short(w.to_address)}</code>
                    {w.kind === 'customer' && <small className="muted"> user {w.customer_ref}</small>}
                  </td>
                  <td>
                    <StatusBadge status={w.status} />
                    {w.status === 'pending_approval' && <small className="muted"> {w.approvals}/{w.approvals_required}</small>}
                    {w.last_error && <small className="muted"> {w.last_error}</small>}
                  </td>
                  <td>
                    {props.canApprove && w.status === 'pending_approval' && (
                      <div className="row">
                        {!w.approved_by.includes(props.selfId) && (
                          <ReasonAction label="Approve" totp sm primary message={`Send ${w.amount} ${tokenOptionText(w.token, w.symbol)} to ${w.to_address}.`} onSubmit={async (reason, h) => { await api('POST', `/withdrawals/${w.id}/approve`, { reason }, h); r.reload(); }} />
                        )}
                        <ReasonAction label="Reject" danger sm message="The amount becomes available to the merchant again." onSubmit={async (reason) => { await api('POST', `/withdrawals/${w.id}/reject`, { reason }); r.reload(); }} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {status === 'pending_approval' && <ApprovalChecklist />}
    </section>
  );
}

// ---------------------------------------------------------------- custody (signer, wallets, treasury)

function NewTreasury(props: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ livemode: true, token: 'bsc:usdt', direction: 'to_cold' as 'to_cold' | 'to_hot', amount: '', tx_hash: '', reason: '' });
  const [code, setCode] = useState('');
  const a = useAction();
  const close = () => {
    setOpen(false);
    setCode('');
  };
  return (
    <>
      <button type="button" className="sm" onClick={() => { setOpen(true); }}><Icon name="plus" size={16} />Treasury transfer</button>
      {open && (
        <Modal title="Treasury transfer" icon="lock" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const { tx_hash, ...rest } = form;
                await api('POST', '/custody/treasury', { ...rest, reason: form.reason.trim(), ...(form.direction === 'to_hot' ? { tx_hash: tx_hash.trim() } : {}) }, totpHeader(code));
                close();
                toast.success(form.direction === 'to_cold' ? 'Proposed: a second admin must approve' : 'Recorded: booked once verified on chain');
                props.onDone();
              });
            }}
          >
            <Field label="Direction">
              <select value={form.direction} onChange={(e) => { setForm({ ...form, direction: e.target.value as 'to_cold' | 'to_hot' }); }}>
                <option value="to_cold">Hot wallet → cold storage</option>
                <option value="to_hot">Cold storage → hot wallet (record a refill)</option>
              </select>
            </Field>
            <div className="row">
              <Field label="Token"><TokenSelect value={form.token} onChange={(id) => { setForm({ ...form, token: id }); }} /></Field>
              <Field label="Amount"><input value={form.amount} onChange={(e) => { setForm({ ...form, amount: e.target.value }); }} inputMode="decimal" required /></Field>
            </div>
            {form.direction === 'to_hot' && (
              <Field label="Refill transaction hash" hint="The multisig's transaction to the hot wallet. Booked only when the chain shows exactly this transfer.">
                <input value={form.tx_hash} onChange={(e) => { setForm({ ...form, tx_hash: e.target.value }); }} pattern="^0x[0-9a-fA-F]{64}$" required spellCheck={false} />
              </Field>
            )}
            <Field label="Reason" hint="Recorded in the audit log."><input value={form.reason} onChange={(e) => { setForm({ ...form, reason: e.target.value }); }} minLength={3} maxLength={500} required /></Field>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={close}>Cancel</button>
              <Submit busy={a.busy}>Submit</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

/** Cap and low-balance alert of the hot wallet for one mode and token (D-105). Empty = off. */
function HotWalletPolicyForm(props: { initial?: HotWalletPolicy; onDone: () => void; label: string; sm?: boolean }) {
  const init = props.initial;
  // Live (mainnets) unless editing an existing policy.
  const blank = { livemode: init?.livemode ?? true, token: init?.token ?? 'bsc:usdt', max_balance: init?.max_balance ?? '', low_balance: init?.low_balance ?? '', reason: '' };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [code, setCode] = useState('');
  const a = useAction();
  const close = () => {
    setOpen(false);
    setCode('');
  };
  return (
    <>
      <button
        type="button"
        className={props.sm ? 'sm secondary' : 'sm'}
        onClick={() => {
          setForm(blank);
          setOpen(true);
        }}
      >
        <Icon name={init ? 'shield' : 'plus'} size={16} />
        {props.label}
      </button>
      {open && (
        <Modal title="Hot wallet limits" icon="lock" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const v = (x: string) => (x.trim() === '' ? null : x.trim());
                await api('PUT', '/custody/hot-wallet-policies', { livemode: form.livemode, token: form.token.trim(), max_balance: v(form.max_balance), low_balance: v(form.low_balance), reason: form.reason.trim() }, totpHeader(code));
                close();
                toast.success('Hot wallet limits saved');
                props.onDone();
              });
            }}
          >
            <div className="row">
              <Field label="Token"><TokenSelect value={form.token} disabled={Boolean(init)} onChange={(id) => { setForm({ ...form, token: id }); }} /></Field>
            </div>
            <div className="row">
              <Field label="Cap (move the rest to cold)" hint="Above this, the excess goes to cold storage automatically. Empty = off.">
                <input value={form.max_balance} onChange={(e) => { setForm({ ...form, max_balance: e.target.value }); }} inputMode="decimal" placeholder="e.g. 1500" />
              </Field>
              <Field label="Alert below" hint="Below this, treasury admins get an email (again every 24 h). Empty = off.">
                <input value={form.low_balance} onChange={(e) => { setForm({ ...form, low_balance: e.target.value }); }} inputMode="decimal" placeholder="e.g. 500" />
              </Field>
            </div>
            <Alert tone="info">Automatic transfers go only to the registered cold wallet, and only if the signer runs with SIGNER_AUTO_TO_COLD=true; otherwise they wait.</Alert>
            <Field label="Reason" hint="Recorded in the audit log."><input value={form.reason} onChange={(e) => { setForm({ ...form, reason: e.target.value }); }} minLength={3} maxLength={500} required /></Field>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={close}>Cancel</button>
              <Submit busy={a.busy}>Save</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

const POLICY_STATE: Record<'low' | 'above_cap' | 'ok', [string, string]> = {
  low: ['badge s-failed', 'below alert'],
  above_cap: ['badge s-pending', 'above cap'],
  ok: ['badge s-active', 'ok'],
};

export function Custody(props: { selfId: string; manage: boolean; superadmin: boolean }) {
  const r = useLoad(() => api<CustodyOverview>('GET', '/custody/'), []);
  const t = useLoad(() => api<{ data: TreasuryTransfer[] }>('GET', '/custody/treasury'), []);
  const fw = useLoad(() => api<{ data: Forward[] }>('GET', '/custody/forwards'), []);
  const hp = useLoad(() => api<{ data: HotWalletPolicy[] }>('GET', '/custody/hot-wallet-policies'), []);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Skeleton />;
  const d = r.data;
  const reload = () => {
    r.reload();
    t.reload();
    hp.reload();
  };
  return (
    <section>
      <header className="page-head">
        <h2>Custody</h2>
        {props.manage && <NewTreasury onDone={reload} />}
      </header>
      {!d.custodial_enabled && <Alert tone="info">Custodial mode is off on this deployment (FEATURE_CUSTODIAL).</Alert>}
      <div className={`card stepup${d.signer.paused ? ' paused' : ''}`}>
        <div>
          <strong>Signer {d.signer.paused ? 'paused' : 'running'}</strong>
          {d.signer.reason && <span className="muted"> · {d.signer.reason}</span>}
          <div className="muted">While paused nothing is swept, paid out or moved; it all waits and continues on resume.</div>
        </div>
        {props.manage && !d.signer.paused && (
          <ReasonAction label="Pause signer" danger message="Every sweep, withdrawal and treasury transfer stops at once." onSubmit={async (reason) => { await api('POST', '/custody/signer/pause', { reason }); reload(); }} />
        )}
        {d.signer.paused && props.superadmin && (
          <ReasonAction label="Resume signer" totp message="Sweeps, withdrawals and treasury transfers continue." onSubmit={async (reason, h) => { await api('POST', '/custody/signer/resume', { reason }, h); reload(); }} />
        )}
      </div>
      <div className="stats">
        <Stat label="Open sweeps" value={String(d.open_sweeps)} icon="refresh" />
        <Stat label="Withdrawals to approve" value={String(d.withdrawals.pending_approval ?? 0)} icon="wallet" {...((d.withdrawals.pending_approval ?? 0) > 0 ? { tone: 'warn' as const } : {})} />
        <Stat label="Withdrawals in flight" value={String((d.withdrawals.approved ?? 0) + (d.withdrawals.sent ?? 0))} icon="activity" />
        {d.forwarder_enabled && <Stat label="Forwards in flight" value={String(d.forwards.open)} icon="refresh" />}
        {d.forwarder_enabled && <Stat label="Forwards failed (24 h)" value={String(d.forwards.failed_24h)} icon="activity" {...(d.forwards.failed_24h > 0 ? { tone: 'warn' as const } : {})} />}
      </div>

      <h3 className="section-title">Balances (ledger)</h3>
      {d.balances.length === 0 && <p className="muted">No custodial funds yet.</p>}
      <div className={d.balances.length === 0 ? 'hidden' : 'table-wrap'}>
        <table>
          <thead>
            <tr><th>Token</th><th className="num">On deposit addresses</th><th className="num">Hot wallet</th><th className="num">Cold storage</th><th className="num">Owed to merchants</th></tr>
          </thead>
          <tbody>
            {d.balances.map((b) => (
              <tr key={`${String(b.livemode)}:${String(b.token)}`}>
                <td><Asset token={String(b.token)} symbol={typeof b.symbol === 'string' ? b.symbol : null} /> {b.livemode ? <span className="badge s-active">live</span> : <span className="badge">test</span>}</td>
                <td className="num">{String(b.platform_deposits ?? '0')}</td>
                <td className="num">{String(b.platform_hot ?? '0')}</td>
                <td className="num">{String(b.platform_cold ?? '0')}</td>
                <td className="num">{String(b.merchant_available ?? '0')} <small className="muted">+ {String(b.merchant_pending ?? '0')} pending, {String(b.merchant_withdrawing ?? '0')} withdrawing</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {d.forwarder_enabled && (
        <>
          <h3 className="section-title">Forwards (wallet-address merchants)</h3>
          <p className="muted">Each confirmed payment to a forwarder address is flushed to the merchant wallet; the fee goes to the fee wallet. A failed forward is retried by the next planning round; a sent one is rebroadcast until mined.</p>
          {fw.data && fw.data.data.length === 0 && <p className="muted">No forwards yet.</p>}
          {fw.data && fw.data.data.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Created</th><th>Invoice</th><th className="num">Amount</th><th className="num">To merchant</th><th className="num">Fee</th><th>Status</th><th>Transaction</th></tr>
                </thead>
                <tbody>
                  {fw.data.data.map((x) => (
                    <tr key={x.id}>
                      <td>{fmtDate(x.created_at)}</td>
                      <td><a href={`#/invoices/${x.invoice_id}`}><code>{short(x.invoice_id)}</code></a> {x.livemode ? <span className="badge s-active">live</span> : <span className="badge">test</span>}</td>
                      <td className="num"><Amount value={x.amount} token={x.token} symbol={x.symbol} /></td>
                      <td className="num">{x.to_merchant ?? '—'}</td>
                      <td className="num">{x.fee ?? '—'}</td>
                      <td><StatusBadge status={x.status} />{x.last_error && <small className="muted"> {x.last_error}</small>}</td>
                      <td>{x.tx_hash ? <code>{short(x.tx_hash)}</code> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="page-head section-title">
        <h3>Hot wallet limits</h3>
        {props.manage && <HotWalletPolicyForm label="Set limits" onDone={reload} />}
      </div>
      <p className="muted">Above the cap, the excess moves to cold storage automatically. Below the alert level, treasury admins get an email so they can refill the hot wallet. Checked every 15 seconds by the custody worker.</p>
      <ErrorBox error={hp.error} />
      {hp.data?.data.length === 0 && <EmptyState icon="lock" title="No hot wallet limits yet" />}
      {hp.data && hp.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Token</th><th className="num">Hot wallet now</th><th className="num">Cap</th><th className="num">Alert below</th><th>Last check</th><th>Last alert</th><th></th></tr>
            </thead>
            <tbody>
              {hp.data.data.map((p) => (
                <tr key={`${String(p.livemode)}:${p.token}`}>
                  <td><Asset token={p.token} symbol={p.symbol} /> {p.livemode ? <span className="badge s-active">live</span> : <span className="badge">test</span>}</td>
                  <td className="num">{p.last_balance ?? '—'} {p.state && <span className={POLICY_STATE[p.state][0]}>{POLICY_STATE[p.state][1]}</span>}</td>
                  <td className="num">{p.max_balance ?? <span className="muted">off</span>}</td>
                  <td className="num">{p.low_balance ?? <span className="muted">off</span>}</td>
                  <td>{p.last_checked_at ? fmtDate(p.last_checked_at) : <span className="muted">not yet</span>}</td>
                  <td>{p.low_alert_at ? fmtDate(p.low_alert_at) : <span className="muted">—</span>}</td>
                  <td>{props.manage && <HotWalletPolicyForm initial={p} label="Edit" sm onDone={reload} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Platform wallets</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Role</th><th>Mode</th><th>Address</th><th>Path</th></tr>
          </thead>
          <tbody>
            {d.wallets.map((w) => (
              <tr key={`${w.kind}:${String(w.livemode)}:${w.family}`}>
                <td>{w.kind}</td>
                <td>{w.livemode ? 'live' : 'test'}</td>
                <td><CopyField value={w.address} /></td>
                <td>{w.derivation_path ? <code>{w.derivation_path}</code> : <span className="muted">multisig</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Treasury transfers</h3>
      <ErrorBox error={t.error} />
      {t.data?.data.length === 0 && <EmptyState icon="coins" title="No treasury transfers yet" />}
      {t.data && t.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Created</th><th>Direction</th><th className="num">Amount</th><th>Status</th><th>Reason</th><th></th></tr>
            </thead>
            <tbody>
              {t.data.data.map((x) => (
                <tr key={x.id}>
                  <td>{fmtDate(x.created_at)} {x.livemode ? <span className="badge s-active">live</span> : <span className="badge">test</span>}</td>
                  <td>{x.direction === 'to_cold' ? 'hot → cold' : 'cold → hot'} {x.auto && <span className="badge">auto</span>}</td>
                  <td className="num"><Amount value={x.amount} token={x.token} /></td>
                  <td><StatusBadge status={x.status} />{x.last_error && <small className="muted"> {x.last_error}</small>}</td>
                  <td>{x.reason}</td>
                  <td>
                    {props.manage && x.status === 'pending_approval' && (
                      <div className="row">
                        {x.requested_by !== props.selfId && (
                          <ReasonAction label="Approve" totp sm primary message={`Move ${x.amount} ${x.token} to ${x.cold_address}.`} onSubmit={async (reason, h) => { await api('POST', `/custody/treasury/${x.id}/approve`, { reason }, h); reload(); }} />
                        )}
                        <ReasonAction label="Reject" danger sm onSubmit={async (reason) => { await api('POST', `/custody/treasury/${x.id}/reject`, { reason }); reload(); }} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

// ---------------------------------------------------------------- risk hooks (M9, D-094)

interface RiskLimit {
  asset: string;
  per_invoice: string | null;
  per_day: string | null;
  updated_at: string;
}

/** Live-mode limits per token: a confirmed payment above one is held for review instead of paid. */
function RiskLimits(props: { merchantId: string; manage: boolean }) {
  const limits = useLoad(() => api<{ data: RiskLimit[] }>('GET', `/merchants/${props.merchantId}/risk-limits`), [props.merchantId]);
  const [asset, setAsset] = useState('bsc:usdt');
  const [perInvoice, setPerInvoice] = useState('');
  const [perDay, setPerDay] = useState('');
  return (
    <fieldset className="card">
      <legend>Risk limits (live)</legend>
      <p className="muted">Above a limit, confirmed payments are held for review instead of paying the invoice. Empty = no limit. Days are UTC.</p>
      {limits.error ? (
        <ErrorBox error={limits.error} />
      ) : !limits.data ? (
        <Skeleton />
      ) : limits.data.data.length === 0 ? (
        <p className="muted">No limits set.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Token</th><th>Per invoice</th><th>Per day</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {limits.data.data.map((l) => (
                <tr key={l.asset}>
                  <td><Asset token={l.asset} /> <code>{l.asset}</code></td>
                  <td className="num">{l.per_invoice ?? '—'}</td>
                  <td className="num">{l.per_day ?? '—'}</td>
                  <td>{fmtDate(l.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.manage && (
        <>
          <div className="form-grid">
            <Field label="Token"><TokenSelect value={asset} onChange={setAsset} /></Field>
            <Field label="Per invoice (token units)"><input value={perInvoice} onChange={(e) => { setPerInvoice(e.target.value); }} inputMode="decimal" placeholder="no limit" /></Field>
            <Field label="Per day (token units)"><input value={perDay} onChange={(e) => { setPerDay(e.target.value); }} inputMode="decimal" placeholder="no limit" /></Field>
          </div>
          <div className="card-actions">
            <ReasonAction
              label="Save limits"
              totp
              primary
              onSubmit={async (reason, h) => {
                await api('PUT', `/merchants/${props.merchantId}/risk-limits`, { asset: asset.trim(), per_invoice: perInvoice.trim() || null, per_day: perDay.trim() || null, reason }, h);
                limits.reload();
              }}
            />
          </div>
        </>
      )}
    </fieldset>
  );
}

interface BlockedAddress {
  id: string;
  family: string;
  address: string;
  reason: string;
  created_at: string;
}

/** Payer blocklist: payments from these addresses are held for review once confirmed. */
export function BlockedPayers(props: { manage: boolean }) {
  const [q, setQ] = useState('');
  const list = useLoad(() => api<{ data: BlockedAddress[] }>('GET', `/risk/blocked-addresses${q ? `?q=${encodeURIComponent(q)}` : ''}`), [q]);
  const [address, setAddress] = useState('');
  return (
    <section>
      <header className="page-head">
        <h2>Blocked payers</h2>
      </header>
      <p className="muted">Confirmed payments from these addresses hold the invoice for review instead of paying it. Unblocking does not release invoices already held.</p>
      {props.manage && (
        <div className="card">
          <div className="form-grid">
            <Field label="EVM address"><input value={address} onChange={(e) => { setAddress(e.target.value); }} placeholder="0x…" spellCheck={false} /></Field>
          </div>
          <div className="card-actions">
            <ReasonAction
              label="Block address"
              primary
              onSubmit={async (reason) => {
                await api('POST', '/risk/blocked-addresses', { family: 'evm', address: address.trim(), reason });
                setAddress('');
                list.reload();
              }}
            />
          </div>
        </div>
      )}
      <Field label="Search"><input value={q} onChange={(e) => { setQ(e.target.value.trim()); }} placeholder="0x…" /></Field>
      {list.error ? (
        <ErrorBox error={list.error} />
      ) : !list.data ? (
        <Skeleton />
      ) : list.data.data.length === 0 ? (
        <EmptyState icon="shield" title="No blocked addresses" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Address</th><th>Reason</th><th>Added</th><th /></tr>
            </thead>
            <tbody>
              {list.data.data.map((b) => (
                <tr key={b.id}>
                  <td><CopyField value={b.address} /></td>
                  <td>{b.reason}</td>
                  <td>{fmtDate(b.created_at)}</td>
                  <td>
                    {props.manage && (
                      <ReasonAction
                        label="Unblock"
                        totp
                        danger
                        sm
                        message={`Payments from ${b.address} will pay invoices again.`}
                        onSubmit={async (reason, h) => { await api('POST', `/risk/blocked-addresses/${b.id}/remove`, { reason }, h); list.reload(); }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- settings (D-106, D-107): one place for platform rules

type Attention = AdminSettings['attention_statuses'][number];
type IpRow = AdminSettings['ip_allowlist'][number];
interface SettingsDraft {
  attention_statuses: Attention[];
  session_idle_minutes: number;
  session_max_hours: number;
  ip_allowlist_enabled: boolean;
  ip_allowlist: IpRow[];
  /** '' = the server limit. */
  withdrawal_two_person_min: string;
  signup_enabled: boolean;
  /** network: '' = every network. */
  merchant_defaults: { fee_bps: string; fee_fixed: string; fee_grace: string; payout_fee: string; underpay_tolerance_bps: string; network: string };
  whitelist_activation_hours: number;
  whitelist_disable_hours: number;
}

const draftOf = (s: AdminSettings): SettingsDraft => ({
  attention_statuses: [...s.attention_statuses].sort(),
  session_idle_minutes: s.session_idle_minutes,
  session_max_hours: s.session_max_hours,
  ip_allowlist_enabled: s.ip_allowlist_enabled,
  ip_allowlist: s.ip_allowlist,
  withdrawal_two_person_min: s.withdrawal_two_person_min ?? '',
  signup_enabled: s.signup_enabled,
  merchant_defaults: {
    fee_bps: String(s.merchant_defaults.fee_bps),
    fee_fixed: s.merchant_defaults.fee_fixed,
    fee_grace: s.merchant_defaults.fee_grace,
    payout_fee: s.merchant_defaults.payout_fee,
    underpay_tolerance_bps: String(s.merchant_defaults.underpay_tolerance_bps),
    network: s.merchant_defaults.network ?? '',
  },
  whitelist_activation_hours: s.whitelist_activation_hours,
  whitelist_disable_hours: s.whitelist_disable_hours,
});

/** Which card each draft field belongs to, for the save summary. */
const SECTION_OF: Record<keyof SettingsDraft, string> = {
  attention_statuses: 'Needs a decision',
  session_idle_minutes: 'Sessions',
  session_max_hours: 'Sessions',
  ip_allowlist_enabled: 'Admin IP allowlist',
  ip_allowlist: 'Admin IP allowlist',
  withdrawal_two_person_min: 'Withdrawals',
  signup_enabled: 'Merchants',
  merchant_defaults: 'Merchants',
  whitelist_activation_hours: 'Merchant whitelists',
  whitelist_disable_hours: 'Merchant whitelists',
};

const ATTENTION_OPTIONS: { status: Attention; title: string; text: string }[] = [
  { status: 'late_payment', title: 'Late payment', text: 'Paid after the invoice expired or was cancelled. Never credited automatically: an admin accepts it.' },
  { status: 'held', title: 'Held for risk review', text: 'A risk rule (blocked payer, merchant limit) held a confirmed payment. Only an admin can release or reject it.' },
  { status: 'underpaid', title: 'Underpaid', text: 'Less than the amount arrived. The customer can still top up until the deadline; custodial invoices then close by themselves as partially paid.' },
];
const IDLE_PRESETS = [15, 30, 60, 120, 240];
const MAX_PRESETS = [4, 8, 12, 24];
const WL_PRESETS = [1, 6, 12, 24, 48, 72];
const fmtMinutes = (m: number) => (m % 60 === 0 ? `${String(m / 60)} h` : `${String(m)} min`);
/** Presets plus the saved value when it is not one of them (set through the API). */
const withValue = (presets: number[], v: number) => (presets.includes(v) ? presets : [...presets, v].sort((a, b) => a - b));

const ipv4 = (s: string): number | null => {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const x of parts) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = n * 256 + Number(x);
  }
  return n;
};
/** UI hint only (the server decides): does an allowlist entry cover this address? IPv4 CIDRs, otherwise exact match. */
function covers(entry: string, ip: string): boolean {
  const [addr = '', bits] = entry.split('/');
  const a = ipv4(addr);
  const b = ipv4(ip.replace(/^::ffff:/i, ''));
  if (a === null || b === null) return addr.toLowerCase() === ip.toLowerCase();
  const size = 2 ** (32 - (bits === undefined ? 32 : Number(bits)));
  return Math.floor(a / size) === Math.floor(b / size);
}
const PRIVATE_IP = /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^(::1|f[cd][0-9a-f]{2}:)/i;

function Switch(props: { checked: boolean; disabled?: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={(e) => { props.onChange(e.target.checked); }} />
      <span className="track" aria-hidden="true" />
    </label>
  );
}

function Presets(props: { values: number[]; value: number; disabled: boolean; fmt: (v: number) => string; label: string; onChange: (v: number) => void }) {
  return (
    <div className="mode presets" role="group" aria-label={props.label}>
      {props.values.map((v) => (
        <button key={v} type="button" className={v === props.value ? 'on' : ''} aria-pressed={v === props.value} disabled={props.disabled} onClick={() => { props.onChange(v); }}>
          {props.fmt(v)}
        </button>
      ))}
    </div>
  );
}

function CardHead(props: { icon: IconName; title: string; children: string }) {
  return (
    <header>
      <span className="card-icon"><Icon name={props.icon} /></span>
      <div>
        <h3>{props.title}</h3>
        <p>{props.children}</p>
      </div>
    </header>
  );
}

const SETTINGS_SECTIONS: [string, string][] = [
  ['set-queue', 'Needs a decision'],
  ['set-sessions', 'Sessions'],
  ['set-ip', 'IP allowlist'],
  ['set-withdrawals', 'Withdrawals'],
  ['set-merchants', 'Merchants'],
  ['set-whitelists', 'Merchant whitelists'],
];

export function Settings(props: { superadmin: boolean }) {
  const r = useLoad(() => api<AdminSettings>('GET', '/settings'), []);
  const reg = useLoad(() => api<RegistryData>('GET', '/registry'), []);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [newIp, setNewIp] = useState({ cidr: '', label: '' });
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Skeleton />;
  const saved = r.data;
  const base = draftOf(saved);
  const cur = draft ?? base;
  const changed = (Object.keys(base) as (keyof SettingsDraft)[]).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(base[k]));
  const locked = !props.superadmin;
  const set = (patch: Partial<SettingsDraft>) => { setDraft({ ...cur, ...patch }); };
  const setDefault = (k: keyof SettingsDraft['merchant_defaults'], v: string) => { set({ merchant_defaults: { ...cur.merchant_defaults, [k]: v } }); };
  const p = saved.platform;
  const me = saved.request_ip;
  const selfAllowed = cur.ip_allowlist.some((e) => covers(e.cidr, me));
  const addIp = (row: IpRow) => {
    const cidr = row.cidr.trim().toLowerCase();
    if (!cidr || cur.ip_allowlist.some((e) => e.cidr === cidr)) return;
    set({ ip_allowlist: [...cur.ip_allowlist, { cidr, label: row.label.trim() }] });
  };
  const sections = [...new Set(changed.map((k) => SECTION_OF[k]))];

  return (
    <section className="settings">
      <header className="page-head">
        <h2>Settings</h2>
        {saved.updated_at && <span className="page-meta"><Icon name="clock" size={14} />Last changed {fmtDate(saved.updated_at)}</span>}
      </header>
      <p className="lede">Every platform rule in one place. Changes need a superadmin and a fresh authenticator code, apply at once and are recorded in the audit log.</p>
      <nav className="settings-nav" aria-label="Sections">
        {SETTINGS_SECTIONS.map(([id, name]) => (
          <button key={id} type="button" className="chip-link" onClick={() => { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
            {name}
          </button>
        ))}
      </nav>
      {locked && <Alert tone="info">Only a superadmin can change these settings. You can see them.</Alert>}

      <div className="card setting-card" id="set-queue">
        <CardHead icon="invoice" title="Needs a decision">Which invoices wait in the Invoices queue for an admin. The status filter there still shows any status.</CardHead>
        {ATTENTION_OPTIONS.map((o) => {
          const on = cur.attention_statuses.includes(o.status);
          return (
            <div className="setting-row" key={o.status}>
              <div className="setting-text">
                <strong>{o.title} <StatusBadge status={o.status} /></strong>
                <span>{o.text}</span>
              </div>
              <Switch
                label={o.title}
                checked={on}
                disabled={locked || (on && cur.attention_statuses.length === 1)}
                onChange={(v) => { set({ attention_statuses: (v ? [...cur.attention_statuses, o.status] : cur.attention_statuses.filter((x) => x !== o.status)).sort() }); }}
              />
            </div>
          );
        })}
        <div className="setting-foot"><Icon name="info" size={14} />At least one status stays on.</div>
      </div>

      <div className="card setting-card" id="set-sessions">
        <CardHead icon="clock" title="Sessions">Working in the console keeps you signed in. Only idle time counts, up to the absolute limit.</CardHead>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Sign out after inactivity</strong>
            <span>No request for this long ends the session.</span>
          </div>
          <Presets label="Sign out after inactivity" values={withValue(IDLE_PRESETS, cur.session_idle_minutes)} value={cur.session_idle_minutes} disabled={locked} fmt={fmtMinutes} onChange={(v) => { set({ session_idle_minutes: v }); }} />
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Sign in again after</strong>
            <span>However active, a session ends this long after sign-in.</span>
          </div>
          <Presets label="Sign in again after" values={withValue(MAX_PRESETS, cur.session_max_hours)} value={cur.session_max_hours} disabled={locked} fmt={(h) => `${String(h)} h`} onChange={(v) => { set({ session_max_hours: v }); }} />
        </div>
        <div className="setting-foot"><Icon name="info" size={14} />Applies to every open session from its next request.</div>
      </div>

      <div className="card setting-card" id="set-ip">
        <CardHead icon="shield" title="Admin IP allowlist">When on, the admin console and its API answer only these addresses. Everyone else gets "not found", even on the sign-in page.</CardHead>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Only allow listed addresses {saved.ip_allowlist_enabled ? <span className="badge s-active">enforced</span> : <span className="badge">off</span>}</strong>
            <span>{cur.ip_allowlist.length === 0 ? 'Add at least one address below first.' : `${String(cur.ip_allowlist.length)} ${cur.ip_allowlist.length === 1 ? 'address' : 'addresses'} on the list.`}</span>
          </div>
          <Switch label="Only allow listed addresses" checked={cur.ip_allowlist_enabled} disabled={locked || (!cur.ip_allowlist_enabled && cur.ip_allowlist.length === 0)} onChange={(v) => { set({ ip_allowlist_enabled: v }); }} />
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Your address <code>{me}</code> {selfAllowed && <span className="badge s-active">on the list</span>}</strong>
            <span>
              {PRIVATE_IP.test(me)
                ? 'This is a private address: the server probably sees its proxy, not you. Set TRUST_PROXY_HOPS on the server before relying on the allowlist.'
                : 'As the server sees it. Add it before switching the allowlist on.'}
            </span>
          </div>
          {!locked && (
            <button type="button" className="secondary sm" disabled={cur.ip_allowlist.some((e) => e.cidr === me)} onClick={() => { addIp({ cidr: me, label: 'Added from the console' }); }}>
              <Icon name="plus" size={14} />Add my address
            </button>
          )}
        </div>
        {cur.ip_allowlist.map((e) => (
          <div className="setting-row ip-row" key={e.cidr}>
            <div className="setting-text">
              <strong><code>{e.cidr}</code> {covers(e.cidr, me) && <span className="badge s-current">you</span>}</strong>
              <span>{e.label || 'No label'}</span>
            </div>
            {!locked && (
              <button type="button" className="ghost icon-only" aria-label={`Remove ${e.cidr}`} title="Remove" onClick={() => { set({ ip_allowlist: cur.ip_allowlist.filter((x) => x.cidr !== e.cidr) }); }}>
                <Icon name="trash" size={16} />
              </button>
            )}
          </div>
        ))}
        {!locked && (
          <form
            className="setting-row ip-add"
            onSubmit={(ev) => {
              ev.preventDefault();
              addIp(newIp);
              setNewIp({ cidr: '', label: '' });
            }}
          >
            <input value={newIp.cidr} onChange={(ev) => { setNewIp({ ...newIp, cidr: ev.target.value }); }} placeholder="203.0.113.7 or 203.0.113.0/24" aria-label="IP address or CIDR" spellCheck={false} required />
            <input value={newIp.label} onChange={(ev) => { setNewIp({ ...newIp, label: ev.target.value }); }} placeholder="Label, e.g. Office" aria-label="Label" maxLength={60} />
            <button type="submit" className="secondary sm"><Icon name="plus" size={14} />Add</button>
          </form>
        )}
        {cur.ip_allowlist_enabled && !selfAllowed && <div className="setting-row"><Alert tone="warning">Your address is not on the list, so saving would lock you out. The server refuses that: add your address first.</Alert></div>}
        <div className="setting-foot">
          <Icon name="info" size={14} />
          {p.admin_ip_allowlist_env > 0 ? `The server also enforces its own list (${String(p.admin_ip_allowlist_env)} entries): both apply.` : 'Locked out? The runbook shows how to switch it off from the database.'}
        </div>
      </div>

      <div className="card setting-card" id="set-withdrawals">
        <CardHead icon="wallet" title="Withdrawals">Who has to approve a merchant's live withdrawal before the signer sends it.</CardHead>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Two admins from <span className="badge s-pending">now {saved.withdrawal_two_person_effective} tokens</span></strong>
            <span>
              A live withdrawal of this many tokens or more needs two different admins; a smaller one needs one admin. At most {p.withdrawal_two_person_max} (the server's limit), so the console can
              only make this stricter. Applies to withdrawals requested after saving.
            </span>
          </div>
          <div className="input-suffix">
            <input
              value={cur.withdrawal_two_person_min}
              onChange={(e) => { set({ withdrawal_two_person_min: e.target.value.replace(/[^\d]/g, '') }); }}
              placeholder={p.withdrawal_two_person_max}
              inputMode="numeric"
              aria-label="Two admins from (tokens)"
              disabled={locked}
            />
            <span>tokens</span>
          </div>
        </div>
        <div className="setting-foot"><Icon name="info" size={14} />Empty = the server's limit ({p.withdrawal_two_person_max}). Counted in token units, whatever the token: 10000 means 10,000 USDT.</div>
      </div>

      <div className="card setting-card" id="set-merchants">
        <CardHead icon="store" title="Merchants">Who can join, and what a new merchant starts with.</CardHead>
        <div className="setting-row">
          <div className="setting-text">
            <strong>New merchant sign-ups</strong>
            <span>{p.signup_allowed ? 'When off, the dashboard sign-up form is refused; existing merchants are not affected.' : 'Closed by the server (SIGNUP_ENABLED=false), whatever this switch says.'}</span>
          </div>
          <Switch label="New merchant sign-ups" checked={cur.signup_enabled} disabled={locked} onChange={(v) => { set({ signup_enabled: v }); }} />
        </div>
        <div className="setting-row stack">
          <div className="setting-text">
            <strong>Defaults for new merchants</strong>
            <span>Existing merchants keep their values; change those on the merchant page.</span>
          </div>
          <div className="form-grid">
            <Field label="Fee rate (bps)" hint="100 bps = 1% of each invoice."><input value={cur.merchant_defaults.fee_bps} onChange={(e) => { setDefault('fee_bps', e.target.value); }} inputMode="numeric" disabled={locked} /></Field>
            <Field label="Fixed fee per invoice" hint="Token units, added to the rate."><input value={cur.merchant_defaults.fee_fixed} onChange={(e) => { setDefault('fee_fixed', e.target.value); }} inputMode="decimal" disabled={locked} /></Field>
            <Field label="Fee grace" hint="How far live prepaid fees may go below zero."><input value={cur.merchant_defaults.fee_grace} onChange={(e) => { setDefault('fee_grace', e.target.value); }} inputMode="decimal" disabled={locked} /></Field>
            <Field label="Payout fee" hint="Per payout to a merchant's user, token units."><input value={cur.merchant_defaults.payout_fee} onChange={(e) => { setDefault('payout_fee', e.target.value); }} inputMode="decimal" disabled={locked} /></Field>
            <Field label="Underpay tolerance (bps)" hint="Paid this much short still counts as paid. 50 = 0.5%."><input value={cur.merchant_defaults.underpay_tolerance_bps} onChange={(e) => { setDefault('underpay_tolerance_bps', e.target.value); }} inputMode="numeric" disabled={locked} /></Field>
            <Field label="Network" hint="The chain a new merchant receives payments on. The merchant can change it in Settings > Network.">
              <select value={cur.merchant_defaults.network} onChange={(e) => { setDefault('network', e.target.value); }} disabled={locked}>
                <option value="">Every enabled network</option>
                {(reg.data?.chains ?? []).filter((c) => !c.testnet).map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (off)'}</option>)}
                {cur.merchant_defaults.network && !(reg.data?.chains ?? []).some((c) => c.id === cur.merchant_defaults.network) && <option value={cur.merchant_defaults.network}>{cur.merchant_defaults.network}</option>}
              </select>
            </Field>
          </div>
        </div>
      </div>

      <div className="card setting-card" id="set-whitelists">
        <CardHead icon="lock" title="Merchant whitelists">The waits that protect merchants' payout address and API IP whitelists if their account is taken over.</CardHead>
        <div className="setting-row">
          <div className="setting-text">
            <strong>New live payout address usable after</strong>
            <span>A newly whitelisted payout address waits this long before payouts can go there; owners are emailed at once.</span>
          </div>
          <Presets label="New live payout address usable after" values={withValue(WL_PRESETS, cur.whitelist_activation_hours)} value={cur.whitelist_activation_hours} disabled={locked} fmt={(h) => `${String(h)} h`} onChange={(v) => { set({ whitelist_activation_hours: v }); }} />
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Switching a whitelist off takes</strong>
            <span>The merchant can cancel until then; owners are emailed when it is scheduled.</span>
          </div>
          <Presets label="Switching a whitelist off takes" values={withValue(WL_PRESETS, cur.whitelist_disable_hours)} value={cur.whitelist_disable_hours} disabled={locked} fmt={(h) => `${String(h)} h`} onChange={(v) => { set({ whitelist_disable_hours: v }); }} />
        </div>
        <div className="setting-foot"><Icon name="info" size={14} />Between 1 and 168 hours. Applies to additions and switch-offs requested after saving.</div>
      </div>

      {changed.length > 0 && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <span className="savebar-text"><span className="dot" aria-hidden="true" />Unsaved: {sections.join(', ')}</span>
          <div className="row">
            <button type="button" className="ghost sm" onClick={() => { setDraft(null); }}>Discard</button>
            <ReasonAction
              label="Save changes"
              totp
              primary
              sm
              message={`Saves: ${sections.join(', ')}. Applies at once.`}
              onSubmit={async (reason, h) => {
                const d = cur.merchant_defaults;
                await api(
                  'PUT',
                  '/settings',
                  {
                    attention_statuses: cur.attention_statuses,
                    session_idle_minutes: cur.session_idle_minutes,
                    session_max_hours: cur.session_max_hours,
                    ip_allowlist_enabled: cur.ip_allowlist_enabled,
                    ip_allowlist: cur.ip_allowlist,
                    withdrawal_two_person_min: cur.withdrawal_two_person_min.trim() || null,
                    signup_enabled: cur.signup_enabled,
                    merchant_defaults: {
                      fee_bps: Number(d.fee_bps),
                      fee_fixed: d.fee_fixed.trim(),
                      fee_grace: d.fee_grace.trim(),
                      payout_fee: d.payout_fee.trim(),
                      underpay_tolerance_bps: Number(d.underpay_tolerance_bps),
                      network: d.network || null,
                    },
                    whitelist_activation_hours: cur.whitelist_activation_hours,
                    whitelist_disable_hours: cur.whitelist_disable_hours,
                    reason,
                  },
                  h,
                );
                setDraft(null);
                r.reload();
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
