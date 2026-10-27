import { useState } from 'react';
import { api, totpHeader, type Balance, type PayoutAddress, type Withdrawal } from './api';
import { Alert, ConfirmButton, CopyField, EmptyState, ErrorBox, Field, Skeleton, Stat, StatusBadge, Submit, TotpInput, fmtDate, short, toast, useAction, useLoad } from './ui';

/** Custodial accounts only: balances held for you, where withdrawals go, and the withdrawals themselves (D-090). */
export function Withdrawals(props: { livemode: boolean; canRequest: boolean; canManageAddress: boolean; totp: boolean }) {
  const q = `livemode=${String(props.livemode)}`;
  const balances = useLoad(() => api<{ data: Balance[] }>('GET', `/balances/?${q}`), [q]);
  const addresses = useLoad(() => api<{ data: PayoutAddress[] }>('GET', `/withdrawals/payout-addresses?${q}`), [q]);
  const list = useLoad(() => api<{ data: Withdrawal[] }>('GET', `/withdrawals/?${q}`), [q]);
  const current = addresses.data?.data.find((a) => a.status === 'current');
  const pending = addresses.data?.data.find((a) => a.status === 'pending');
  const reload = () => {
    balances.reload();
    addresses.reload();
    list.reload();
  };

  return (
    <section>
      <header className="page-head">
        <h2>Withdrawals</h2>
      </header>
      {!props.totp && <Alert tone="warning">Turn on two-factor authentication (Security) to add a payout address or withdraw.</Alert>}
      <div className="stats">
        {(balances.data?.data ?? []).map((b) => (
          <Stat key={b.token} label={`Available · ${b.token}`} value={b.available} unit={b.symbol} icon="wallet">
            <span>Not swept yet {b.pending}</span>
            <span>·</span>
            <span>Withdrawing {b.withdrawing}</span>
          </Stat>
        ))}
      </div>
      <p className="muted">
        Payments become available once they are confirmed and moved into custody (usually minutes). Fees are deducted then.
      </p>

      <h3 className="section-title">Payout address</h3>
      <ErrorBox error={addresses.error} />
      {!addresses.data && !addresses.error && <Skeleton />}
      {current ? (
        <dl className="details card">
          <dt>Withdrawals go to</dt>
          <dd><CopyField value={current.address} /> {current.label && <span className="muted">{current.label}</span>}</dd>
          <dt>Since</dt>
          <dd>{fmtDate(current.activates_at)}</dd>
        </dl>
      ) : (
        addresses.data && <Alert tone="info">No payout address yet.</Alert>
      )}
      {pending && (
        <Alert tone="warning">
          New address <code>{pending.address}</code> takes over at {fmtDate(pending.activates_at)}. If you did not add it, cancel it now and change your
          password.{' '}
          {props.canManageAddress && (
            <ConfirmButton
              label="Cancel new address"
              message="The current address keeps receiving withdrawals."
              onConfirm={() => {
                void api('POST', `/withdrawals/payout-addresses/${pending.id}/cancel`).then(() => {
                  toast.success('New payout address cancelled');
                  reload();
                });
              }}
            />
          )}
        </Alert>
      )}
      {props.canManageAddress && props.totp && <AddAddress livemode={props.livemode} onDone={reload} />}

      {props.canRequest && props.totp && current && <RequestWithdrawal livemode={props.livemode} balances={balances.data?.data ?? []} to={current.address} onDone={reload} />}

      <h3 className="section-title">History</h3>
      <ErrorBox error={list.error} />
      {list.data && list.data.data.length === 0 && <EmptyState icon="wallet" title="No withdrawals yet" />}
      {list.data && list.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Requested</th><th className="num">Amount</th><th>To</th><th>Status</th><th>Transaction</th><th></th></tr>
            </thead>
            <tbody>
              {list.data.data.map((w) => (
                <tr key={w.id}>
                  <td>{fmtDate(w.created_at)}</td>
                  <td className="num">{w.amount} {w.symbol}</td>
                  <td><code>{short(w.to_address)}</code></td>
                  <td>
                    <StatusBadge status={w.status} />
                    {w.status === 'pending_approval' && <small className="muted"> {w.approvals}/{w.approvals_required} approvals</small>}
                    {w.reason && <small className="muted"> {w.reason}</small>}
                  </td>
                  <td>{w.tx_hash ? <code>{short(w.tx_hash)}</code> : <span className="muted">—</span>}</td>
                  <td>
                    {props.canRequest && w.status === 'pending_approval' && (
                      <ConfirmButton
                        label="Cancel"
                        message="The amount becomes available again."
                        onConfirm={() => {
                          void api('POST', `/withdrawals/${w.id}/cancel`).then(() => {
                            toast.success('Withdrawal cancelled');
                            reload();
                          });
                        }}
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

function AddAddress(props: { livemode: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  if (!open) {
    return (
      <div className="row">
        <button type="button" className="secondary" onClick={() => { setOpen(true); }}>Set a payout address</button>
      </div>
    );
  }
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api('POST', '/withdrawals/payout-addresses', { livemode: props.livemode, address: address.trim(), ...(label.trim() ? { label: label.trim() } : {}) }, totpHeader(code));
          toast.success(props.livemode ? 'Payout address added' : 'Payout address set', props.livemode ? 'It takes over in 24 hours. Owners were emailed.' : undefined);
          setOpen(false);
          setAddress('');
          setLabel('');
          setCode('');
          props.onDone();
        });
      }}
    >
      {props.livemode && <Alert tone="info">For your security a new live address takes over after 24 hours, and every owner is emailed.</Alert>}
      <Field label="Address" hint="Your wallet's address on this network (0x…). Copy and paste it: a typo means lost funds.">
        <input value={address} onChange={(e) => { setAddress(e.target.value); }} required pattern="^0x[0-9a-fA-F]{40}$" spellCheck={false} data-autofocus />
      </Field>
      <Field label="Label" hint="Optional, e.g. 'Treasury Ledger'.">
        <input value={label} onChange={(e) => { setLabel(e.target.value); }} maxLength={100} />
      </Field>
      <TotpInput value={code} onChange={setCode} />
      <ErrorBox error={a.error} />
      <div className="row end">
        <button type="button" className="secondary" onClick={() => { setOpen(false); }}>Cancel</button>
        <Submit busy={a.busy}>Save address</Submit>
      </div>
    </form>
  );
}

function RequestWithdrawal(props: { livemode: boolean; balances: Balance[]; to: string; onDone: () => void }) {
  const withFunds = props.balances.filter((b) => Number(b.available) > 0);
  const [token, setToken] = useState(withFunds[0]?.token ?? '');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  if (withFunds.length === 0) return null;
  const selected = withFunds.find((b) => b.token === token) ?? withFunds[0];
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          const w = await api<Withdrawal>('POST', '/withdrawals/', { livemode: props.livemode, token: selected?.token ?? token, amount: amount.trim() }, totpHeader(code));
          toast.success('Withdrawal requested', w.status === 'pending_approval' ? 'It is sent once approved.' : 'It is on its way.');
          setAmount('');
          setCode('');
          props.onDone();
        });
      }}
    >
      <h3>Withdraw</h3>
      <div className="row">
        <Field label="Token">
          <select value={selected?.token} onChange={(e) => { setToken(e.target.value); }}>
            {withFunds.map((b) => <option key={b.token} value={b.token}>{b.token} ({b.available} available)</option>)}
          </select>
        </Field>
        <Field label="Amount">
          <input value={amount} onChange={(e) => { setAmount(e.target.value); }} inputMode="decimal" pattern="^\d+(\.\d+)?$" required placeholder={selected?.available} />
        </Field>
        <button type="button" className="secondary sm" onClick={() => { setAmount(selected?.available ?? ''); }}>Max</button>
      </div>
      <p className="muted">To <code>{props.to}</code>. Network fees are on us.</p>
      <TotpInput value={code} onChange={setCode} />
      <ErrorBox error={a.error} />
      <div className="row end">
        <Submit busy={a.busy}>Request withdrawal</Submit>
      </div>
    </form>
  );
}
