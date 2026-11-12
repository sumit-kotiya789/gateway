// Which network the merchant receives live payments on (D-113): the merchant's own choice (owner or admin + 2FA).
// One mainnet only, or every enabled one. Existing invoices and deposit addresses keep working after a change.
import { logoUri, networkOf } from '@gw/networks';
import { useState } from 'react';
import { api, totpHeader, type MerchantSettings } from './api';
import { NetworkName } from './asset';
import { Alert, ErrorBox, Skeleton, Submit, TotpInput, toast, useAction, useLoad } from './ui';

export function NetworkSettings(props: { canManage: boolean; totp: boolean; onChange: () => void }) {
  const s = useLoad(() => api<MerchantSettings>('GET', '/settings/'), []);
  const [want, setWant] = useState<string | null | undefined>(undefined);
  const [code, setCode] = useState('');
  const a = useAction();
  if (s.error) return <ErrorBox error={s.error} />;
  if (!s.data) return <Skeleton />;
  const cur = s.data.network;
  const chosen = want === undefined ? cur : want;
  const editable = props.canManage && props.totp;
  const options: { id: string | null; title: string; sub: string }[] = [
    { id: null, title: 'Every network', sub: s.data.networks.map((n) => n.name).join(', ') || 'None enabled right now' },
    ...s.data.networks.map((n) => ({ id: n.id, title: n.name, sub: networkOf(n.id) ? `USDT · ${networkOf(n.id)?.tag ?? ''}` : n.id })),
  ];
  // A network that was switched off by the platform after it was chosen: still shown, so the merchant sees why.
  if (cur && !s.data.networks.some((n) => n.id === cur)) options.push({ id: cur, title: cur, sub: 'Switched off by the platform right now' });

  return (
    <section>
      <header className="page-head"><h2>Network</h2></header>
      <p className="lede-sm">
        Choose the chain your customers pay you on. With one network, new invoices, payment links and user deposit addresses are only offered there.
        Invoices and deposit addresses that already exist keep working, and withdrawals are not affected.
      </p>
      <div className="card">
        <dl className="details">
          <dt>Now</dt>
          <dd>{cur ? <NetworkName chain={cur} /> : 'Every network'}</dd>
        </dl>
      </div>
      {!props.canManage && <Alert tone="info">Only the owner or an admin can change the network.</Alert>}
      {props.canManage && !props.totp && <Alert tone="warning">Turn on two-factor authentication (Security) to change the network.</Alert>}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api('PUT', '/settings/network', { network: chosen }, totpHeader(code));
            toast.success('Network saved', chosen ? `New payments come in on ${networkOf(chosen)?.name ?? chosen} only.` : 'You can take payments on every network.');
            setWant(undefined);
            setCode('');
            s.reload();
            props.onChange();
          });
        }}
      >
        <div className="token-picker" role="radiogroup" aria-label="Network">
          {options.map((o) => {
            const n = o.id ? networkOf(o.id) : undefined;
            return (
              <label key={o.id ?? 'all'} className={`token-option${o.id === chosen ? ' on' : ''}`}>
                <input type="radio" name="network" checked={o.id === chosen} disabled={!editable} onChange={() => { setWant(o.id); }} />
                {o.id === null ? (
                  <span className="net-stack" aria-hidden="true">
                    {s.data?.networks.map((x) => {
                      const m = networkOf(x.id);
                      return m ? <img key={x.id} src={logoUri(m.logo)} alt="" /> : null;
                    })}
                  </span>
                ) : n ? (
                  <img className="net-option-logo" src={logoUri(n.logo)} alt="" />
                ) : (
                  <span className="net-option-logo logo-generic">{o.title.slice(0, 1).toUpperCase()}</span>
                )}
                <span className="to-text">
                  <b>{o.title}</b>
                  <small>{o.sub}</small>
                </span>
              </label>
            );
          })}
        </div>
        {editable && chosen !== cur && (
          <>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={() => { setWant(undefined); }}>Cancel</button>
              <Submit busy={a.busy}>Save network</Submit>
            </div>
          </>
        )}
      </form>
    </section>
  );
}
