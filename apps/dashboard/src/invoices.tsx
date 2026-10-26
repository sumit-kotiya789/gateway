import { useState } from 'react';
import { api, download, type Balance, type FeeTopup, type Invoice, type Page, type Token } from './api';
import { ConfirmButton, ErrorBox, Field, StatusBadge, fmtDate, short, useAction, useLoad } from './ui';

const STATUSES = ['pending', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'settled', 'expired', 'cancelled', 'failed', 'late_payment'];

export function Invoices(props: { livemode: boolean; canWrite: boolean; canExport: boolean }) {
  const [status, setStatus] = useState('');
  const [extra, setExtra] = useState<Invoice[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const qs = `livemode=${String(props.livemode)}${status ? `&status=${status}` : ''}`;
  const page = useLoad(async () => {
    const p = await api<Page<Invoice>>('GET', `/invoices/?${qs}`);
    setExtra([]);
    setCursor(p.next_cursor);
    return p;
  }, [qs]);
  const more = useAction();
  const rows = [...(page.data?.data ?? []), ...extra];
  const balances = useLoad(() => api<{ data: Balance[] }>('GET', `/balances/?livemode=${String(props.livemode)}`), [props.livemode]);

  return (
    <section>
      {(balances.data?.data ?? []).length > 0 && (
        <div className="row balances">
          {(balances.data?.data ?? []).map((b) => (
            <div key={b.token} className="card">
              <small className="muted">Received · {b.token}</small>
              <strong className="num">{b.received} {b.symbol}</strong>
              <small className="muted">Platform fees charged: {b.fees_charged} {b.symbol}</small>
              <small className={b.fee_status === 'blocked' || b.fee_status === 'low' ? 'warn-text' : 'muted'}>
                Prepaid fees: {b.prepaid_fees} {b.symbol}
                {b.fee_status === 'blocked' && ' · used up: top up to create live invoices'}
                {b.fee_status === 'low' && ' · running low'}
              </small>
            </div>
          ))}
        </div>
      )}
      <FeeTopups livemode={props.livemode} />
      {props.canExport && <Exports livemode={props.livemode} />}
      <header className="page-head">
        <h2>Invoices</h2>
        <div className="row">
          <select value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
          {props.canWrite && !creating && <button onClick={() => { setCreating(true); }}>New invoice</button>}
        </div>
      </header>
      {creating && (
        <NewInvoice
          livemode={props.livemode}
          onCancel={() => { setCreating(false); }}
          onCreated={(inv) => { location.hash = `#/invoices/${inv.id}`; }}
        />
      )}
      <ErrorBox error={page.error} />
      {page.data && rows.length === 0 && <p className="muted">No invoices yet.</p>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Created</th><th>Amount</th><th>Status</th><th>Order</th><th>Address</th></tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => { location.hash = `#/invoices/${i.id}`; }}>
                  <td>{fmtDate(i.created_at)}</td>
                  <td className="num">{i.amount} {i.symbol}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td>{i.external_order_id ?? '—'}</td>
                  <td><code>{short(i.deposit_address)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button
          className="secondary"
          disabled={more.busy}
          onClick={() => {
            void more.run(async () => {
              const p = await api<Page<Invoice>>('GET', `/invoices/?${qs}&starting_after=${cursor}`);
              setExtra([...extra, ...p.data]);
              setCursor(p.next_cursor);
            });
          }}
        >
          Load more
        </button>
      )}
      <ErrorBox error={more.error} />
    </section>
  );
}

function NewInvoice(props: { livemode: boolean; onCancel: () => void; onCreated: (inv: Invoice) => void }) {
  const tokens = useLoad(() => api<{ data: Token[] }>('GET', `/tokens/?livemode=${String(props.livemode)}`), [props.livemode]);
  const [form, setForm] = useState({ token: '', amount: '', description: '', external_order_id: '', minutes: '30' });
  const a = useAction();
  const list = tokens.data?.data ?? [];
  const token = form.token || list[0]?.id || '';
  const min = list.find((t) => t.id === token)?.min_amount;

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          const inv = await api<Invoice>('POST', '/invoices/', {
            livemode: props.livemode,
            token,
            amount: form.amount.trim(),
            expires_in: Number(form.minutes) * 60,
            ...(form.description.trim() ? { description: form.description.trim() } : {}),
            ...(form.external_order_id.trim() ? { external_order_id: form.external_order_id.trim() } : {}),
          });
          props.onCreated(inv);
        });
      }}
    >
      <h3>New {props.livemode ? 'live' : 'test'} invoice</h3>
      <ErrorBox error={tokens.error} />
      {tokens.data && list.length === 0 && <p className="muted">No tokens are enabled for {props.livemode ? 'live' : 'test'} mode.</p>}
      <div className="grid">
        <Field label="Token">
          <select value={token} onChange={(e) => { setForm({ ...form, token: e.target.value }); }} required>
            {list.map((t) => (
              <option key={t.id} value={t.id}>{t.symbol} · {t.chain_id}</option>
            ))}
          </select>
        </Field>
        <Field label="Amount" {...(min ? { hint: `Minimum ${min}` } : {})}>
          <input value={form.amount} onChange={(e) => { setForm({ ...form, amount: e.target.value }); }} inputMode="decimal" placeholder="25.00" pattern="\d+(\.\d+)?" required />
        </Field>
        <Field label="Expires in (minutes)">
          <input type="number" min={5} max={1440} value={form.minutes} onChange={(e) => { setForm({ ...form, minutes: e.target.value }); }} required />
        </Field>
        <Field label="Order id (optional)">
          <input value={form.external_order_id} onChange={(e) => { setForm({ ...form, external_order_id: e.target.value }); }} maxLength={200} />
        </Field>
      </div>
      <Field label="Description (optional)">
        <input value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); }} maxLength={500} />
      </Field>
      <ErrorBox error={a.error} />
      <div className="row">
        <button disabled={a.busy || !token}>Create invoice</button>
        <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function InvoiceDetail(props: { id: string; canWrite: boolean }) {
  const inv = useLoad(() => api<Invoice>('GET', `/invoices/${props.id}`), [props.id]);
  const a = useAction();
  const i = inv.data;
  return (
    <section>
      <p><a href="#/invoices">← Invoices</a></p>
      <ErrorBox error={inv.error} />
      {i && (
        <>
          <header className="page-head">
            <h2>{i.amount} {i.symbol} <StatusBadge status={i.status} /></h2>
            {props.canWrite && i.status === 'pending' && (
              <ConfirmButton
                label="Cancel invoice"
                confirm="Confirm cancel"
                disabled={a.busy}
                onConfirm={() => { void a.run(async () => { await api('POST', `/invoices/${i.id}/cancel`); inv.reload(); }); }}
              />
            )}
          </header>
          <ErrorBox error={a.error} />
          {!i.livemode && <p className="muted">Test invoice: pay it with testnet tokens only.</p>}
          <dl className="details">
            <dt>Invoice id</dt><dd><code>{i.id}</code></dd>
            <dt>Received</dt><dd>{i.amount_received} {i.symbol}</dd>
            <dt>Network</dt><dd>{i.network}</dd>
            <dt>Deposit address</dt><dd><code>{i.deposit_address}</code></dd>
            <dt>Checkout</dt><dd><a href={i.checkout_url} target="_blank" rel="noopener noreferrer">{i.checkout_url}</a></dd>
            <dt>Order id</dt><dd>{i.external_order_id ?? '—'}</dd>
            <dt>Description</dt><dd>{i.description ?? '—'}</dd>
            <dt>Expires</dt><dd>{fmtDate(i.expires_at)}</dd>
            <dt>Created</dt><dd>{fmtDate(i.created_at)}</dd>
          </dl>
          <h3>Payments</h3>
          {(i.payments ?? []).length === 0 ? (
            <p className="muted">No payment seen on-chain yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Transaction</th><th>From</th><th>Amount</th><th>Block</th><th>Status</th></tr></thead>
                <tbody>
                  {(i.payments ?? []).map((p) => (
                    <tr key={p.tx_hash + p.block_number}>
                      <td><code>{short(p.tx_hash, 8)}</code></td>
                      <td><code>{short(p.from)}</code></td>
                      <td className="num">{p.amount} {i.symbol}</td>
                      <td>{p.block_number}</td>
                      <td>{p.status === 'detected' ? `waiting for ${String(p.confirmations_required)} confirmations` : p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>History</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>
                {(i.history ?? []).map((h, n) => (
                  <tr key={n}><td>{fmtDate(h.at)}</td><td><StatusBadge status={h.to} /></td><td>{h.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Prepaid fee top-ups recorded for this mode (D-076). Live invoices need a positive prepaid balance per token. */
function FeeTopups(props: { livemode: boolean }) {
  const list = useLoad(() => api<{ data: FeeTopup[] }>('GET', `/fee-topups/?livemode=${String(props.livemode)}`), [props.livemode]);
  const rows = list.data?.data ?? [];
  if (rows.length === 0) return null;
  return (
    <details className="card">
      <summary>Prepaid fee top-ups ({rows.length})</summary>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Amount</th><th>Reference</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}><td>{fmtDate(t.created_at)}</td><td className="num">{t.amount} {t.symbol} <small className="muted">{t.token}</small></td><td><code>{t.reference}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** CSV exports of invoices and payments for a date range (UTC days, at most 366). */
function Exports(props: { livemode: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const a = useAction();
  const get = (kind: 'invoices' | 'payments') => {
    void a.run(() => download(`/exports/${kind}.csv?livemode=${String(props.livemode)}&from=${from}&to=${to}`));
  };
  return (
    <details className="card">
      <summary>Export CSV</summary>
      <div className="row">
        <Field label="From"><input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); }} /></Field>
        <Field label="To"><input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); }} /></Field>
      </div>
      <div className="row">
        <button className="secondary" disabled={a.busy} onClick={() => { get('invoices'); }}>Invoices</button>
        <button className="secondary" disabled={a.busy} onClick={() => { get('payments'); }}>Payments</button>
      </div>
      <ErrorBox error={a.error} />
    </details>
  );
}
