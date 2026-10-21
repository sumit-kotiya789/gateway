import { useState } from 'react';
import { api, type Invoice, type Page, type Token } from './api';
import { ConfirmButton, ErrorBox, Field, StatusBadge, fmtDate, short, useAction, useLoad } from './ui';

const STATUSES = ['pending', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'settled', 'expired', 'cancelled', 'failed', 'late_payment'];

export function Invoices(props: { livemode: boolean; canWrite: boolean }) {
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

  return (
    <section>
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
