import { useState } from 'react';
import { api } from './api';
import { Amount, Asset } from './asset';
import { CopyField, EmptyState, ErrorBox, Field, Skeleton, StatusBadge, fmtDate, short, useLoad } from './ui';

interface DepositAccount {
  id: string;
  customer_ref: string;
  token: string;
  symbol: string;
  address: string;
  custody_mode: string;
  received: string;
  retired_at: string | null;
  created_at: string;
}
interface AccountDetail extends DepositAccount {
  deposits: { invoice_id: string; status: string; amount: string; fee: string | null; deposit_ref: string; created_at: string }[];
}

/**
 * Your users' permanent deposit addresses (D-101): your app asks for one per user and token
 * (POST /v1/deposit-accounts) and shows it; every transfer to it is a deposit, credited when it settles.
 */
export function UserDeposits(props: { livemode: boolean }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = `livemode=${String(props.livemode)}${filter.trim() ? `&customer_ref=${encodeURIComponent(filter.trim())}` : ''}`;
  const list = useLoad(() => api<{ data: DepositAccount[] }>('GET', `/deposit-accounts/?${q}&limit=100`), [q]);
  const rows = list.data?.data ?? [];
  return (
    <section>
      <header className="page-head">
        <h2>User deposits</h2>
        <Field label="User">
          <input value={filter} onChange={(e) => { setFilter(e.target.value); }} placeholder="customer_ref" />
        </Field>
      </header>
      <p className="muted">
        Each of your users gets one permanent address per token from your app (POST /v1/deposit-accounts). Credit the user when you receive
        <code> invoice.settled </code> with <code>kind: deposit</code> and their <code>customer_ref</code>.
      </p>
      <ErrorBox error={list.error} />
      {!list.data && !list.error && <Skeleton />}
      {list.data && rows.length === 0 && <EmptyState icon="wallet" title="No user addresses yet" />}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Token</th><th>Address</th><th className="num">Received</th><th>Mode</th><th>Created</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => { setOpen(open === a.id ? null : a.id); }}>
                  <td><code>{a.customer_ref}</code>{a.retired_at && <span className="badge s-retired">retired</span>}</td>
                  <td><Asset token={a.token} symbol={a.symbol} /></td>
                  <td><code>{short(a.address)}</code></td>
                  <td className="num"><Amount value={a.received} token={a.token} symbol={a.symbol} tag={false} /></td>
                  <td>{a.custody_mode === 'custodial' ? 'custody on' : 'custody off'}</td>
                  <td>{fmtDate(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <AccountDeposits id={open} livemode={props.livemode} />}
    </section>
  );
}

function AccountDeposits(props: { id: string; livemode: boolean }) {
  const d = useLoad(() => api<AccountDetail>('GET', `/deposit-accounts/${props.id}?livemode=${String(props.livemode)}`), [props.id, props.livemode]);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data) return <Skeleton />;
  const a = d.data;
  return (
    <div className="card">
      <h3>{a.customer_ref} · <Asset token={a.token} symbol={a.symbol} /></h3>
      <dl className="details">
        <dt>Deposit address</dt><dd><CopyField value={a.address} /></dd>
        <dt>Received</dt><dd><Amount value={a.received} token={a.token} symbol={a.symbol} /></dd>
      </dl>
      {a.deposits.length === 0 ? (
        <p className="muted">No deposits yet.</p>
      ) : (
        <div className="table-wrap flat">
          <table>
            <thead><tr><th>Date</th><th className="num">Amount</th><th className="num">Fee</th><th>Status</th><th>Transaction</th></tr></thead>
            <tbody>
              {a.deposits.map((x) => (
                <tr key={x.invoice_id}>
                  <td><a href={`#/invoices/${x.invoice_id}`}>{fmtDate(x.created_at)}</a></td>
                  <td className="num">{x.amount}</td>
                  <td className="num">{x.fee ?? '—'}</td>
                  <td><StatusBadge status={x.status} /></td>
                  <td><code>{short(x.deposit_ref.split(':')[0] ?? '')}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
