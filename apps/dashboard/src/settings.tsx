import { useState } from 'react';
import { api, totpHeader, type DerivationReport, type Xpub, type XpubChange, type XpubList, type XpubPreview } from './api';
import { ConfirmButton, ErrorBox, Field, SecretOnce, StatusBadge, TotpInput, fmtDate, useAction, useLoad } from './ui';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Signs the ownership challenge with a browser wallet (MetaMask etc.), from the account that is address 0/0. */
async function signWithWallet(message: string, address: string): Promise<string> {
  const eth = (window as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No browser wallet found. Sign the message with any wallet that holds this address and paste the signature.');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts.some((a) => a.toLowerCase() === address.toLowerCase())) {
    throw new Error(`Connect the account ${address} (the first account of this wallet) and try again.`);
  }
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return (await eth.request({ method: 'personal_sign', params: [hex, address] })) as string;
}

function PendingChange(props: { change: XpubChange; canManage: boolean; onChange: () => void }) {
  const a = useAction();
  const c = props.change;
  return (
    <div className="card warning">
      <h3>Payout xpub change scheduled</h3>
      <p>
        From <strong>{fmtDate(c.activates_at)}</strong>, new invoices will use <code>{c.xpub_hint}</code> (first address <code>{c.first_address}</code>). Until
        then the current xpub stays active.
      </p>
      <p>If you did not request this, cancel it now and change your password.</p>
      <ErrorBox error={a.error} />
      {props.canManage && (
        <ConfirmButton
          label="Cancel change"
          confirm="Cancel the scheduled xpub change?"
          disabled={a.busy}
          onConfirm={() => { void a.run(async () => { await api('POST', `/xpubs/changes/${c.id}/cancel`); props.onChange(); }); }}
        />
      )}
    </div>
  );
}

const PAGE = 50;

function Addresses(props: { xpub: Xpub }) {
  const [offset, setOffset] = useState(0);
  const r = useLoad(() => api<DerivationReport>('GET', `/xpubs/${props.xpub.id}/addresses?offset=${String(offset)}&limit=${String(PAGE)}`), [props.xpub.id, offset]);
  const rep = r.data;
  return (
    <details className="card">
      <summary>Derived addresses ({props.xpub.next_index} used)</summary>
      <ErrorBox error={r.error} />
      {rep && (
        <>
          <p className={rep.wallet_gap_limit > 20 ? 'notice' : 'muted'}>
            Set your wallet&apos;s address gap limit to at least <strong>{rep.wallet_gap_limit}</strong> so it finds every payment
            {rep.highest_used_index === null ? '' : ` (highest paid index: ${String(rep.highest_used_index)})`}. Unpaid invoices leave unused addresses.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Index</th><th>Address</th><th>Invoice</th><th>Received</th></tr></thead>
              <tbody>
                {rep.data.map((d) => (
                  <tr key={d.index}>
                    <td>{d.index}</td>
                    <td><code>{d.address}</code></td>
                    <td>{d.invoice_status ? <StatusBadge status={d.invoice_status} /> : '—'}</td>
                    <td>{d.amount_received && d.amount_received !== '0' ? `${d.amount_received} ${d.symbol ?? ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - PAGE)); }}>Previous</button>
            <button disabled={offset + PAGE >= rep.next_index} onClick={() => { setOffset(offset + PAGE); }}>Next</button>
          </div>
        </>
      )}
    </details>
  );
}

export function Xpubs(props: { livemode: boolean; canManage: boolean; totp: boolean; custodyMode: string }) {
  const list = useLoad(() => api<XpubList>('GET', `/xpubs/?livemode=${String(props.livemode)}`), [props.livemode]);
  const [xpub, setXpub] = useState('');
  const [preview, setPreview] = useState<XpubPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [signature, setSignature] = useState('');
  const [code, setCode] = useState('');
  const [scheduled, setScheduled] = useState(false);
  const a = useAction();
  const sign = useAction();
  const rows = list.data?.data ?? [];
  const pending = list.data?.pending_change ?? null;
  const active = rows.find((x) => x.status === 'active');
  const mode = props.livemode ? 'live' : 'test';
  const needsProof = props.livemode;
  const reset = () => {
    setPreview(undefined);
    setConfirmed(false);
    setSignature('');
  };

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
      {pending && <PendingChange change={pending} canManage={props.canManage} onChange={list.reload} />}
      {scheduled && !pending && <p className="notice">Change scheduled.</p>}
      {list.data && !active && <p className="notice">No {mode} xpub yet: {mode} invoices cannot be created until you add one.</p>}
      {active && (
        <>
          <dl className="details card">
            <dt>Active {mode} xpub</dt><dd><code>{active.xpub_hint}</code></dd>
            <dt>Fingerprint</dt><dd><code>{active.fingerprint}</code></dd>
            <dt>First address (0/0)</dt><dd><code>{active.first_address}</code></dd>
            <dt>Next index</dt><dd>{active.next_index} <small className="muted">(addresses used so far; unpaid invoices leave gaps)</small></dd>
            <dt>Ownership</dt><dd>{active.ownership_proved_at ? `proved ${fmtDate(active.ownership_proved_at)}` : 'not proved'}</dd>
            <dt>Added</dt><dd>{fmtDate(active.created_at)}</dd>
          </dl>
          <Addresses xpub={active} />
        </>
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

      {props.canManage && !pending ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              if (!preview) {
                setPreview(await api<XpubPreview>('POST', '/xpubs/preview', { xpub: xpub.trim(), livemode: props.livemode }));
                return;
              }
              const ownership = signature.trim() ? { issued_at: preview.ownership_challenge.issued_at, signature: signature.trim() } : undefined;
              const r = await api<Xpub | { pending_change: XpubChange }>('POST', '/xpubs/', { livemode: props.livemode, xpub: xpub.trim(), ownership }, totpHeader(code));
              setScheduled('pending_change' in r);
              setXpub('');
              setCode('');
              reset();
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
              onChange={(e) => { setXpub(e.target.value); reset(); }}
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
              <h4>Prove you control this wallet{needsProof ? '' : ' (optional in test mode)'}</h4>
              <p className="muted">
                Sign this message with the wallet&apos;s first account, <code>{preview.ownership_challenge.address}</code>. Signing is free and sends no
                transaction. The signature is valid for 15 minutes.
              </p>
              <pre className="challenge">{preview.ownership_challenge.message}</pre>
              <div className="row">
                <button
                  type="button"
                  disabled={sign.busy}
                  onClick={() => { void sign.run(async () => { setSignature(await signWithWallet(preview.ownership_challenge.message, preview.ownership_challenge.address)); }); }}
                >
                  Sign with browser wallet
                </button>
                {signature && <span className="muted">Signed.</span>}
              </div>
              <ErrorBox error={sign.error} />
              <Field label="Signature" hint="Filled in by the browser wallet, or paste one from another wallet (0x…, 65 bytes).">
                <input value={signature} onChange={(e) => { setSignature(e.target.value); }} spellCheck={false} autoComplete="off" />
              </Field>
              {active && props.livemode && (
                <p className="notice">For your protection the new live xpub takes effect 24 hours after you register it. The current one keeps working until then.</p>
              )}
              {active && !props.livemode && <p className="muted">The current xpub will be retired. Its existing invoices keep their addresses.</p>}
              <TotpInput value={code} onChange={setCode} />
            </div>
          )}
          <ErrorBox error={a.error} />
          {preview ? (
            <button disabled={a.busy || !confirmed || !props.totp || (needsProof && !signature.trim())}>Register xpub</button>
          ) : (
            <button disabled={a.busy}>Preview addresses</button>
          )}
        </form>
      ) : (
        !props.canManage && <p className="muted">Only the account owner can change the payout xpub.</p>
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
