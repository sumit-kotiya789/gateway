// Marketplace sellers (M9, D-095): sub-accounts whose invoices pay into this merchant's wallet.
import { useState } from 'react';
import { api } from './api';
import { EmptyState, ErrorBox, Field, Icon, Skeleton, StatusBadge, Submit, fmtDate, toast, useAction, useLoad } from './ui';

export interface Seller {
  id: string;
  name: string;
  reference: string | null;
  active: boolean;
  created_at: string;
  totals?: { token: string; symbol: string; invoices: number; received: string }[];
}

/** Active sellers of a mode, for selects (invoice and webhook forms). */
export function useSellers(livemode: boolean) {
  const r = useLoad(() => api<{ data: Seller[] }>('GET', `/sub-merchants/?livemode=${String(livemode)}&limit=100`), [livemode]);
  return (r.data?.data ?? []).filter((s) => s.active);
}

/** Optional seller select; empty = the merchant itself. */
export function SellerSelect(props: { livemode: boolean; value: string; onChange: (id: string) => void; emptyLabel: string }) {
  const sellers = useSellers(props.livemode);
  if (sellers.length === 0) return null;
  return (
    <Field label="Seller (optional)">
      <select value={props.value} onChange={(e) => { props.onChange(e.target.value); }}>
        <option value="">{props.emptyLabel}</option>
        {sellers.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.reference ? ` · ${s.reference}` : ''}</option>
        ))}
      </select>
    </Field>
  );
}

function Totals(props: { id: string; livemode: boolean }) {
  const r = useLoad(() => api<Seller>('GET', `/sub-merchants/${props.id}?livemode=${String(props.livemode)}`), [props.id, props.livemode]);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Skeleton />;
  const totals = r.data.totals ?? [];
  return totals.length === 0 ? (
    <span className="muted">No paid invoices yet</span>
  ) : (
    <>{totals.map((t) => <div key={t.token} className="num">{t.received} {t.symbol} · {t.invoices} paid</div>)}</>
  );
}

export function Sellers(props: { livemode: boolean; canWrite: boolean }) {
  const list = useLoad(() => api<{ data: Seller[] }>('GET', `/sub-merchants/?livemode=${String(props.livemode)}&limit=100`), [props.livemode]);
  const [form, setForm] = useState({ name: '', reference: '' });
  const [open, setOpen] = useState<string | null>(null);
  const a = useAction();
  const toggle = useAction();
  return (
    <section>
      <header className="page-head">
        <h2>Sellers</h2>
      </header>
      <p className="muted">
        Marketplace sellers: name one on an invoice (API <code>sub_merchant</code>) to track what each sold. Payments still go to your wallet; you pay
        your sellers. Webhook endpoints can be limited to one seller.
      </p>
      {props.canWrite && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await api('POST', '/sub-merchants/', { livemode: props.livemode, name: form.name.trim(), ...(form.reference.trim() ? { reference: form.reference.trim() } : {}) });
              toast.success('Seller added');
              setForm({ name: '', reference: '' });
              list.reload();
            });
          }}
        >
          <h3>Add {props.livemode ? 'live' : 'test'} seller</h3>
          <div className="grid">
            <Field label="Name"><input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} maxLength={200} required /></Field>
            <Field label="Your reference (optional)"><input value={form.reference} onChange={(e) => { setForm({ ...form, reference: e.target.value }); }} maxLength={200} /></Field>
          </div>
          <ErrorBox error={a.error} />
          <Submit busy={a.busy}><Icon name="plus" size={16} /> Add seller</Submit>
        </form>
      )}
      <ErrorBox error={list.error ?? toggle.error} />
      {!list.data ? (
        <Skeleton />
      ) : list.data.data.length === 0 ? (
        <EmptyState icon="store" title="No sellers yet" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Reference</th><th>Status</th><th>Received</th><th>Added</th><th /></tr>
            </thead>
            <tbody>
              {list.data.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.reference ?? '—'}</td>
                  <td><StatusBadge status={s.active ? 'active' : 'inactive'} /></td>
                  <td>
                    {open === s.id ? (
                      <Totals id={s.id} livemode={props.livemode} />
                    ) : (
                      <button type="button" className="ghost sm" onClick={() => { setOpen(s.id); }}>Show totals</button>
                    )}
                  </td>
                  <td>{fmtDate(s.created_at)}</td>
                  <td>
                    {props.canWrite && (
                      <button
                        type="button"
                        className="secondary sm"
                        disabled={toggle.busy}
                        onClick={() => {
                          void toggle.run(async () => {
                            await api('PATCH', `/sub-merchants/${s.id}`, { livemode: props.livemode, active: !s.active });
                            list.reload();
                          });
                        }}
                      >
                        {s.active ? 'Deactivate' : 'Activate'}
                      </button>
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
