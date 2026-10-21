import { useState } from 'react';
import { api, totpHeader, type Xpub, type XpubPreview } from './api';
import { ErrorBox, Field, SecretOnce, TotpInput, fmtDate, useAction, useLoad } from './ui';

export function Xpubs(props: { livemode: boolean; canManage: boolean; totp: boolean; custodyMode: string }) {
  const list = useLoad(() => api<{ data: Xpub[] }>('GET', `/xpubs/?livemode=${String(props.livemode)}`), [props.livemode]);
  const [xpub, setXpub] = useState('');
  const [preview, setPreview] = useState<XpubPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [code, setCode] = useState('');
  const a = useAction();
  const rows = list.data?.data ?? [];
  const active = rows.find((x) => x.status === 'active');
  const mode = props.livemode ? 'live' : 'test';

  if (props.custodyMode !== 'non_custodial_xpub') {
    return (
      <section>
        <header className="page-head"><h2>Payout wallet (xpub)</h2></header>
        <p className="muted">This account uses {props.custodyMode.replace(/_/g, ' ')} settlement; no xpub is needed.</p>
      </section>
    );
  }

  return (
    <section>
      <header className="page-head"><h2>Payout wallet (xpub)</h2></header>
      <p>
        Every invoice gets a fresh deposit address derived from your account xpub, so payments land directly in your own wallet. We
        never hold your keys.
      </p>
      <ErrorBox error={list.error} />
      {list.data && !active && <p className="notice">No {mode} xpub yet: {mode} invoices cannot be created until you add one.</p>}
      {active && (
        <dl className="details card">
          <dt>Active {mode} xpub</dt><dd><code>{active.xpub_hint}</code></dd>
          <dt>Fingerprint</dt><dd><code>{active.fingerprint}</code></dd>
          <dt>First address (0/0)</dt><dd><code>{active.first_address}</code></dd>
          <dt>Next index</dt><dd>{active.next_index} <small className="muted">(addresses used so far; unpaid invoices leave gaps)</small></dd>
          <dt>Added</dt><dd>{fmtDate(active.created_at)}</dd>
        </dl>
      )}
      {rows.some((x) => x.status === 'retired') && (
        <details>
          <summary>Retired xpubs</summary>
          <ul>
            {rows.filter((x) => x.status === 'retired').map((x) => (
              <li key={x.id}><code>{x.xpub_hint}</code> · first address <code>{x.first_address}</code> · used {x.next_index} · retired {fmtDate(x.retired_at)}</li>
            ))}
          </ul>
        </details>
      )}

      {props.canManage ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              if (!preview) {
                setPreview(await api<XpubPreview>('POST', '/xpubs/preview', { xpub: xpub.trim() }));
                return;
              }
              await api('POST', '/xpubs/', { livemode: props.livemode, xpub: xpub.trim() }, totpHeader(code));
              setXpub('');
              setPreview(undefined);
              setConfirmed(false);
              setCode('');
              list.reload();
            });
          }}
        >
          <h3>{active ? `Replace ${mode} xpub` : `Add ${mode} xpub`}</h3>
          <p className="warning">
            Paste the <strong>account-level extended PUBLIC key</strong> (xpub/tpub, path m/44&apos;/60&apos;/0&apos;). Never paste a seed phrase or a private key
            (xprv). Use different keys for test and live mode.
          </p>
          {!props.totp && <p className="notice">Needs two-factor authentication. <a href="#/security">Enable it in Security.</a></p>}
          <Field label="Extended public key">
            <textarea
              value={xpub}
              onChange={(e) => { setXpub(e.target.value); setPreview(undefined); setConfirmed(false); }}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              required
            />
          </Field>
          {preview && (
            <div className="preview">
              <p>Check that your wallet shows these receive addresses, in this order:</p>
              <ol start={0}>
                {preview.addresses.map((p) => (
                  <li key={p.index}><code>{p.address}</code> <small className="muted">{p.path}</small></li>
                ))}
              </ol>
              <label className="check">
                <input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); }} /> These addresses match my wallet.
              </label>
              {active && <p className="muted">The current xpub will be retired. Its existing invoices keep their addresses.</p>}
              <TotpInput value={code} onChange={setCode} />
            </div>
          )}
          <ErrorBox error={a.error} />
          {preview ? (
            <button disabled={a.busy || !confirmed || !props.totp}>Register xpub</button>
          ) : (
            <button disabled={a.busy}>Preview addresses</button>
          )}
        </form>
      ) : (
        <p className="muted">Only the account owner can change the payout xpub.</p>
      )}
    </section>
  );
}

interface Setup {
  secret: string;
  otpauth_uri: string;
  qr_svg: string;
}

export function Security(props: { totp: boolean; onChange: () => void }) {
  const [setup, setSetup] = useState<Setup>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const a = useAction();

  if (codes) {
    return (
      <section>
        <header className="page-head"><h2>Security</h2></header>
        <SecretOnce label="Recovery codes" value={codes.join('\n')} onDone={() => { setCodes(undefined); props.onChange(); }} />
        <p className="muted">Each code works once if you lose your authenticator. Store them somewhere safe and offline.</p>
      </section>
    );
  }

  return (
    <section>
      <header className="page-head"><h2>Security</h2></header>
      <div className="card">
        <h3>Two-factor authentication</h3>
        {props.totp ? (
          <p>Enabled. You are asked for a code at sign-in and before sensitive changes (API keys, webhooks, payout xpub).</p>
        ) : setup ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                setCodes((await api<{ recovery_codes: string[] }>('POST', '/auth/2fa/enable', { code })).recovery_codes);
                setSetup(undefined);
              });
            }}
          >
            <p>Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
            <img className="qr" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} alt="TOTP QR code" width={200} height={200} />
            <p className="muted">Can&apos;t scan? Enter this key manually: <code>{setup.secret}</code></p>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <button disabled={a.busy}>Enable</button>
          </form>
        ) : (
          <>
            <p>Not enabled. Two-factor authentication is required to create API keys, webhooks and to set your payout xpub.</p>
            <ErrorBox error={a.error} />
            <button disabled={a.busy} onClick={() => { void a.run(async () => { setSetup(await api<Setup>('POST', '/auth/2fa/setup')); }); }}>
              Set up two-factor authentication
            </button>
          </>
        )}
      </div>
    </section>
  );
}
