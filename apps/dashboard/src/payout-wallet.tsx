import { useState } from 'react';
import { api, totpHeader, type MerchantSettings, type ReceivingMode } from './api';
import { Xpubs } from './settings';
import { Alert, ErrorBox, Skeleton, Submit, TotpInput, toast, useAction, useLoad } from './ui';
import { PayoutAddressSection } from './withdrawals';

/**
 * How the merchant receives payments, their own choice: custody off with a wallet address (each invoice gets a
 * forwarder contract that pays it, fee split on-chain, D-097) or their own xpub (a derived address per invoice), or
 * custody on (the platform holds the funds, the merchant withdraws them, D-098).
 */
export function PayoutWallet(props: { livemode: boolean; canManage: boolean; totp: boolean; onModeChange: () => void }) {
  const settings = useLoad(() => api<MerchantSettings>('GET', '/settings/'), []);
  const s = settings.data;
  const modes = s ? MODES.filter((m) => m.mode === s.receiving_mode || availableIn(s, m.mode)) : [];
  return (
    <section>
      <header className="page-head">
        <h2>Payout wallet</h2>
      </header>
      <ErrorBox error={settings.error} />
      {!s && !settings.error && <Skeleton />}
      {s && modes.length > 1 && (
        <ModeChoice
          mode={s.receiving_mode}
          modes={modes}
          canManage={props.canManage}
          totp={props.totp}
          onDone={() => {
            settings.reload();
            props.onModeChange();
          }}
        />
      )}
      {s?.receiving_mode === 'custodial' && (
        <>
          <h3 className="section-title">Custody is on</h3>
          <p className="muted">
            Every invoice gets its own deposit address. Confirmed payments are collected into the platform wallet and added to your balance, minus the
            platform fee. Withdraw to your payout address whenever you want.
          </p>
          <div className="row">
            <a className="btn" href="#/withdrawals">Go to withdrawals</a>
          </div>
        </>
      )}
      {s?.receiving_mode === 'non_custodial_forwarder' && (
        <>
          <h3 className="section-title">Payout address ({props.livemode ? 'live' : 'test'})</h3>
          <p className="muted">
            Every invoice gets its own deposit address. As soon as a payment is confirmed it is forwarded to this address automatically, minus the
            platform fee, by a contract that can only pay you. Use an address you control on this network (MetaMask, Trust Wallet, a hardware wallet).
          </p>
          {!props.totp && <Alert tone="warning">Turn on two-factor authentication (Security) to set your payout address.</Alert>}
          <PayoutAddressSection
            livemode={props.livemode}
            canManage={props.canManage}
            totp={props.totp}
            currentLabel="Payments are forwarded to"
            keepsLabel="The current address keeps receiving payments."
          />
        </>
      )}
      {s?.receiving_mode === 'non_custodial_xpub' && <Xpubs livemode={props.livemode} canManage={props.canManage} totp={props.totp} custodyMode={s.receiving_mode} embedded />}
    </section>
  );
}

type Mode = { mode: ReceivingMode; title: string; text: string };

const MODES: Mode[] = [
  { mode: 'non_custodial_forwarder', title: 'Wallet address (custody off)', text: 'Paste any wallet address. Payments are forwarded to it automatically, fee deducted on-chain.' },
  { mode: 'custodial', title: 'Custody on', text: 'We hold your payments for you and you withdraw them to your wallet whenever you want. Fee deducted per payment.' },
  { mode: 'non_custodial_xpub', title: 'Extended public key (custody off)', text: 'For hardware wallets and advanced setups: payments land directly on addresses of your own wallet.' },
];

function availableIn(s: MerchantSettings, mode: ReceivingMode): boolean {
  if (mode === 'custodial') return s.custodial_available;
  if (mode === 'non_custodial_forwarder') return s.forwarder_available;
  return true;
}

function ModeChoice(props: { mode: ReceivingMode; modes: Mode[]; canManage: boolean; totp: boolean; onDone: () => void }) {
  const [want, setWant] = useState<ReceivingMode>(props.mode);
  const [code, setCode] = useState('');
  const a = useAction();
  const changing = want !== props.mode;
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api('PUT', '/settings/receiving-mode', { mode: want }, totpHeader(code));
          toast.success('Receiving mode changed', 'New invoices use it; existing ones keep theirs.');
          setCode('');
          props.onDone();
        });
      }}
    >
      <p className="label">How do you want to receive payments?</p>
      <div className="choices">
        {props.modes.map((m) => (
          <label key={m.mode} className={want === m.mode ? 'choice selected' : 'choice'}>
            <input type="radio" name="receiving-mode" value={m.mode} checked={want === m.mode} disabled={!props.canManage} onChange={() => { setWant(m.mode); }} />
            <span>
              <strong>{m.title}</strong>
              <small className="muted">{m.text}</small>
            </span>
          </label>
        ))}
      </div>
      {changing && (
        <>
          <Alert tone="info">
            Applies to new invoices; existing invoices keep the mode they were created with. Locked after your first live invoice.
            {props.mode === 'custodial' && ' To turn custody off, first withdraw your whole balance and let open invoices finish.'}
          </Alert>
          {props.totp ? <TotpInput value={code} onChange={setCode} /> : <Alert tone="warning">Turn on two-factor authentication (Security) first.</Alert>}
          <ErrorBox error={a.error} />
          <div className="row end">
            <Submit busy={a.busy}>Switch</Submit>
          </div>
        </>
      )}
    </form>
  );
}
