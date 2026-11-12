import { useState } from 'react';
import { api, totpHeader, type Balance, type PayoutAddress, type Withdrawal, type WithdrawalLimits } from './api';
import { Amount, Asset, tokenOptionText } from './asset';
import { Alert, ConfirmButton, CopyField, EmptyState, ErrorBox, Field, Modal, Skeleton, Stat, StatusBadge, Submit, TotpInput, fmtDate, short, toast, useAction, useLoad } from './ui';

/** Custodial accounts only: balances held for you, where withdrawals go, and the withdrawals themselves (D-090). */
export function Withdrawals(props: { livemode: boolean; enabled: boolean; canRequest: boolean; canManageAddress: boolean; totp: boolean }) {
  const q = `livemode=${String(props.livemode)}`;
  const balances = useLoad(() => api<{ data: Balance[] }>('GET', `/balances/?${q}`), [q]);
  const addresses = useLoad(() => api<{ data: PayoutAddress[] }>('GET', `/withdrawals/payout-addresses?${q}`), [q]);
  const list = useLoad(() => api<{ data: Withdrawal[] }>('GET', `/withdrawals/?${q}`), [q]);
  // Every active wallet can be picked for a self withdrawal (D-114); the current one first.
  const wallets = (addresses.data?.data ?? []).filter((a) => a.status === 'current' || a.status === 'active');
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
      {!props.enabled && <Alert tone="info">Withdrawals are paused: custody is off on this platform. Your balance stays safe; requests open again when custody is back on.</Alert>}
      {props.enabled && !props.totp && <Alert tone="warning">Turn on two-factor authentication (Security) to add a payout address or withdraw.</Alert>}
      <div className="stats">
        {(balances.data?.data ?? []).map((b) => (
          <Stat key={b.token} label="Available" value={b.available} unit={<Asset token={b.token} symbol={b.symbol} />} icon="wallet">
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
      <PayoutAddressSection livemode={props.livemode} canManage={props.canManageAddress} totp={props.totp} currentLabel="Withdrawals go to" keepsLabel="Your active wallets keep receiving withdrawals." onChange={reload} wallets />

      {props.enabled && props.canRequest && props.totp && wallets.length > 0 && <SelfWithdrawal livemode={props.livemode} balances={balances.data?.data ?? []} wallets={wallets} onDone={reload} />}

      <LimitsSection livemode={props.livemode} tokens={(balances.data?.data ?? []).map((b) => ({ id: b.token, symbol: b.symbol }))} canManage={props.canManageAddress} totp={props.totp} />

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
                  <td className="num"><Amount value={w.amount} token={w.token} symbol={w.symbol} /></td>
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

      <UserPayouts livemode={props.livemode} />
    </section>
  );
}

/**
 * Your own withdrawal limits per token (D-100): one transaction at most, and at most per 24 hours, across your
 * withdrawals and your payouts to users. Live payouts to users need both. Owner + 2FA; changes apply at once.
 */
function LimitsSection(props: { livemode: boolean; tokens: { id: string; symbol: string | null }[]; canManage: boolean; totp: boolean }) {
  const q = `livemode=${String(props.livemode)}`;
  const limits = useLoad(() => api<{ data: WithdrawalLimits[] }>('GET', `/withdrawals/limits?${q}`), [q]);
  const rows = limits.data?.data ?? [];
  const symbolOf = new Map([...props.tokens.map((t) => [t.id, t.symbol ?? t.id] as const), ...rows.map((r) => [r.token, r.symbol] as const)]);
  const tokens = [...symbolOf.keys()].sort();
  const [token, setToken] = useState('');
  const chosen = token || tokens[0] || '';
  const cur = rows.find((r) => r.token === chosen);
  const [perTx, setPerTx] = useState<string | null>(null);
  const [perDay, setPerDay] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const a = useAction();
  const txValue = perTx ?? cur?.per_tx ?? '';
  const dayValue = perDay ?? cur?.per_day ?? '';
  return (
    <>
      <h3 className="section-title">Withdrawal limits</h3>
      <p className="muted">
        Caps for your withdrawals and your payouts to users, per token. A request above them is refused. Live payouts to users need both limits.
      </p>
      <ErrorBox error={limits.error} />
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Token</th><th className="num">One-time</th><th className="num">Daily</th><th className="num">Used (24 h)</th><th>Changed</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.token}>
                  <td><Asset token={r.token} symbol={r.symbol} /></td>
                  <td className="num">{r.per_tx ?? <span className="muted">no limit</span>}</td>
                  <td className="num">{r.per_day ?? <span className="muted">no limit</span>}</td>
                  <td className="num"><Amount value={r.used_24h} token={r.token} symbol={r.symbol} tag={false} /></td>
                  <td>{fmtDate(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.canManage && props.totp && tokens.length > 0 && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              const blank = (v: string) => (v.trim() === '' ? null : v.trim());
              await api('PUT', '/withdrawals/limits', { livemode: props.livemode, token: chosen, per_tx: blank(txValue), per_day: blank(dayValue) }, totpHeader(code));
              toast.success('Limits saved', 'They apply to new requests at once.');
              setPerTx(null);
              setPerDay(null);
              setCode('');
              limits.reload();
            });
          }}
        >
          <div className="row">
            <Field label="Token">
              <select value={chosen} onChange={(e) => { setToken(e.target.value); setPerTx(null); setPerDay(null); }}>
                {tokens.map((t) => <option key={t} value={t}>{tokenOptionText(t, symbolOf.get(t) ?? t)}</option>)}
              </select>
            </Field>
            <Field label="One-time limit" hint="Empty = no limit">
              <input value={txValue} onChange={(e) => { setPerTx(e.target.value); }} inputMode="decimal" pattern="^\d+(\.\d+)?$" />
            </Field>
            <Field label="Daily limit (24 h)" hint="Empty = no limit">
              <input value={dayValue} onChange={(e) => { setPerDay(e.target.value); }} inputMode="decimal" pattern="^\d+(\.\d+)?$" />
            </Field>
          </div>
          <TotpInput value={code} onChange={setCode} />
          <ErrorBox error={a.error} />
          <div className="row end">
            <Submit busy={a.busy}>Save limits</Submit>
          </div>
        </form>
      )}
    </>
  );
}

/** Payouts to your users, requested by your app with a `payouts:write` key (POST /v1/payouts, D-100). */
function UserPayouts(props: { livemode: boolean }) {
  const list = useLoad(() => api<{ data: Withdrawal[] }>('GET', `/withdrawals/?livemode=${String(props.livemode)}&kind=customer`), [props.livemode]);
  const rows = list.data?.data ?? [];
  return (
    <>
      <h3 className="section-title">Payouts to your users</h3>
      <ErrorBox error={list.error} />
      {list.data && rows.length === 0 && <p className="muted">None yet. Your app sends them with POST /v1/payouts (key scope payouts:write).</p>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Requested</th><th>User</th><th className="num">Amount</th><th className="num">Fee</th><th>To</th><th>Status</th><th>Transaction</th></tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td>{fmtDate(w.created_at)}</td>
                  <td><code>{w.customer_ref}</code></td>
                  <td className="num"><Amount value={w.amount} token={w.token} symbol={w.symbol} /></td>
                  <td className="num">{w.fee}</td>
                  <td><code>{short(w.to_address)}</code></td>
                  <td><StatusBadge status={w.status} />{w.reason && <small className="muted"> {w.reason}</small>}</td>
                  <td>{w.tx_hash ? <code>{short(w.tx_hash)}</code> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Payout wallets (D-090, D-114). Forwarder payouts (D-097) and withdrawals without a choice go to the current one (the
 * newest active); with `wallets`, every saved wallet is listed and a self withdrawal may pick any active one. A new live
 * wallet works after 24 hours (owners are emailed); a pending one can be cancelled and an active one removed.
 */
export function PayoutAddressSection(props: { livemode: boolean; canManage: boolean; totp: boolean; currentLabel: string; keepsLabel: string; onChange?: () => void; wallets?: boolean }) {
  const q = `livemode=${String(props.livemode)}`;
  const addresses = useLoad(() => api<{ data: PayoutAddress[] }>('GET', `/withdrawals/payout-addresses?${q}`), [q]);
  const current = addresses.data?.data.find((a) => a.status === 'current');
  const pending = addresses.data?.data.find((a) => a.status === 'pending');
  const saved = (addresses.data?.data ?? []).filter((a) => a.status !== 'cancelled');
  const reload = () => {
    addresses.reload();
    props.onChange?.();
  };
  const cancel = (a: PayoutAddress) => {
    void api('POST', `/withdrawals/payout-addresses/${a.id}/cancel`).then(() => {
      toast.success(a.status === 'pending' ? 'New payout address cancelled' : 'Wallet removed');
      reload();
    });
  };
  return (
    <>
    <ErrorBox error={addresses.error} />
    {!addresses.data && !addresses.error && <Skeleton />}
    {props.wallets && saved.length > 0 ? (
      <div className="table-wrap">
        <table>
          <thead><tr><th>Wallet</th><th>Address</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {saved.map((a) => (
              <tr key={a.id}>
                <td>{a.label ?? <span className="muted">No label</span>} {a.status === 'current' && <span className="badge s-active">default</span>}</td>
                <td><CopyField value={a.address} /></td>
                <td>{a.status === 'pending' ? <span className="muted">usable from {fmtDate(a.activates_at)}</span> : <span className="badge s-active">active</span>}</td>
                <td>
                  {props.canManage && (
                    <ConfirmButton
                      label={a.status === 'pending' ? 'Cancel' : 'Remove'}
                      message={a.status === 'pending' ? 'This wallet will never become usable.' : 'It can no longer be picked for a withdrawal; requests to it that are not sent yet fail and are released.'}
                      onConfirm={() => { cancel(a); }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : current ? (
      <dl className="details card">
        <dt>{props.currentLabel}</dt>
        <dd><CopyField value={current.address} /> {current.label && <span className="muted">{current.label}</span>}</dd>
        <dt>Since</dt>
        <dd>{fmtDate(current.activates_at)}</dd>
      </dl>
    ) : (
      addresses.data && <Alert tone="info">No payout address yet.</Alert>
    )}
    {pending && (
      <Alert tone="warning">
        New address <code>{pending.address}</code> {props.wallets ? 'becomes usable' : 'takes over'} at {fmtDate(pending.activates_at)}. If you did not add it, cancel
        it now and change your password.{' '}
        {props.canManage && <ConfirmButton label="Cancel new address" message={props.keepsLabel} onConfirm={() => { cancel(pending); }} />}
      </Alert>
    )}
    {props.canManage && props.totp && <AddAddress livemode={props.livemode} onDone={reload} more={Boolean(props.wallets && saved.length > 0)} />}
    </>
  );
}

function AddAddress(props: { livemode: boolean; onDone: () => void; more?: boolean }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  if (!open) {
    return (
      <div className="row">
        <button type="button" className="secondary" onClick={() => { setOpen(true); }}>{props.more ? 'Add a wallet' : 'Set a payout address'}</button>
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
      <Field label="Address" hint="Your wallet's 0x address. The same address receives on every network we support (BNB Smart Chain, Ethereum, Polygon), so use a wallet you control on all of them, not an exchange deposit address. Copy and paste it: a typo means lost funds.">
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

/**
 * Self withdrawal (D-114): the merchant's own balance to one of its saved, active wallets, picked here. Live requests
 * wait for the platform's approval; the database and the signer check the wallet again before anything is sent.
 */
function SelfWithdrawal(props: { livemode: boolean; balances: Balance[]; wallets: PayoutAddress[]; onDone: () => void }) {
  const withFunds = props.balances.filter((b) => Number(b.available) > 0);
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState('');
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  const to = props.wallets.find((w) => w.id === wallet) ?? props.wallets[0];
  const selected = withFunds.find((b) => b.token === token) ?? withFunds[0];
  const close = () => {
    setOpen(false);
    setAmount('');
    setCode('');
  };
  return (
    <>
      <div className="row">
        <button type="button" className="primary" disabled={withFunds.length === 0} onClick={() => { setOpen(true); }}>Self withdrawal</button>
        {withFunds.length === 0 && <span className="muted">Nothing available to withdraw yet.</span>}
      </div>
      {open && (
        <Modal title="Self withdrawal" icon="wallet" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const w = await api<Withdrawal>(
                  'POST',
                  '/withdrawals/',
                  { livemode: props.livemode, token: selected?.token ?? token, amount: amount.trim(), payout_address_id: to?.id },
                  totpHeader(code),
                );
                toast.success('Withdrawal requested', w.status === 'pending_approval' ? 'It is sent once approved.' : 'It is on its way.');
                close();
                props.onDone();
              });
            }}
          >
            <div className="field">
              <span id="self-wallet-label">To wallet</span>
              <div className="token-picker" role="radiogroup" aria-labelledby="self-wallet-label">
                {props.wallets.map((w) => (
                  <label key={w.id} className={`token-option${w.id === to?.id ? ' on' : ''}`}>
                    <input type="radio" name="self-wallet" checked={w.id === to?.id} onChange={() => { setWallet(w.id); }} />
                    <span className="to-text">
                      <b>{w.label ?? 'Wallet'}{w.status === 'current' ? ' · default' : ''}</b>
                      <small><code>{short(w.address, 8)}</code></small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="row">
              <Field label="Token">
                <select value={selected?.token} onChange={(e) => { setToken(e.target.value); }}>
                  {withFunds.map((b) => <option key={b.token} value={b.token}>{tokenOptionText(b.token, b.symbol ?? b.token)} ({b.available} available)</option>)}
                </select>
              </Field>
              <Field label="Amount">
                <input value={amount} onChange={(e) => { setAmount(e.target.value); }} inputMode="decimal" pattern="^\d+(\.\d+)?$" required placeholder={selected?.available} data-autofocus />
              </Field>
              <button type="button" className="secondary sm" onClick={() => { setAmount(selected?.available ?? ''); }}>Max</button>
            </div>
            {to && <p className="muted">To <code>{to.address}</code>{selected && <> on the token&apos;s network</>}. Network fees are on us.</p>}
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={close}>Cancel</button>
              <Submit busy={a.busy}>Request withdrawal</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
