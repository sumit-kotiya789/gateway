// Funds security (D-109): the payout address whitelist (per mode) and the API IP whitelist. Owner only for changes,
// each with a fresh 2FA code; removing an address needs none. Switching a whitelist on is immediate, off is scheduled.
import { useRef, useState, type ReactNode } from 'react';
import { api, totpHeader, type WhitelistState, type WhitelistedAddress } from './api';
import { ago } from './format';
import { Alert, ConfirmButton, CopyButton, EmptyState, ErrorBox, Field, Icon, Modal, Skeleton, Submit, TotpInput, fmtDate, short, toast, useAction, useLoad } from './ui';

/** A form in a dialog that ends with a 2FA code; `onSubmit` gets the x-totp-code header. */
function TotpDialog(props: { title: string; message?: string; submit: string; danger?: boolean; onClose: () => void; onSubmit: (h: Record<string, string>) => Promise<void>; children?: ReactNode }) {
  const [code, setCode] = useState('');
  const a = useAction();
  return (
    <Modal title={props.title} icon={props.danger ? 'alert' : 'shield'} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await props.onSubmit(totpHeader(code));
            props.onClose();
          });
        }}
      >
        {props.message && <p>{props.message}</p>}
        {props.children}
        <TotpInput value={code} onChange={setCode} />
        <ErrorBox error={a.error} />
        <div className="row end">
          <button type="button" className="secondary" onClick={props.onClose}>Cancel</button>
          <Submit busy={a.busy} className={props.danger ? 'danger' : ''}>{props.submit}</Submit>
        </div>
      </form>
    </Modal>
  );
}

const Needs2fa = () => (
  <Alert tone="warning">Changing whitelists needs two-factor authentication. <a href="#/settings/security">Enable it in Security.</a></Alert>
);

/** The on/off banner with the scheduled switch-off, shared by both whitelists. */
function SwitchCard(props: { title: string; on: boolean; disableAt: string | null; disableHours: number; canManage: boolean; totp: boolean; onSet: (enabled: boolean, h: Record<string, string>) => Promise<void>; offHint: string; onHint: string; canEnable?: boolean }) {
  const [dialog, setDialog] = useState<'on' | 'off' | null>(null);
  return (
    <div className={`card wl-switch ${props.on ? (props.disableAt ? 'leaving' : 'on') : 'off'}`}>
      <span className="wl-shield"><Icon name="shield" size={22} /></span>
      <div className="wl-switch-text">
        <strong>{props.title} {props.on ? (props.disableAt ? 'switching off' : 'enabled') : 'disabled'}</strong>
        <span className="muted">
          {props.on
            ? props.disableAt
              ? `Stays on until ${fmtDate(props.disableAt)}, then switches off. Cancel to keep it on.`
              : props.onHint
            : props.offHint}
        </span>
      </div>
      {props.canManage && props.totp && (
        <div className="row">
          {props.on && props.disableAt && <button type="button" onClick={() => { setDialog('on'); }}>Keep it on</button>}
          {props.on && !props.disableAt && <button type="button" className="danger-outline" onClick={() => { setDialog('off'); }}>Switch off</button>}
          {!props.on && <button type="button" disabled={props.canEnable === false} onClick={() => { setDialog('on'); }}>Switch on</button>}
        </div>
      )}
      {dialog && (
        <TotpDialog
          title={dialog === 'on' ? (props.disableAt ? 'Keep the whitelist on' : 'Switch the whitelist on') : 'Switch the whitelist off'}
          message={dialog === 'on' ? 'Applies at once.' : `For your safety this takes ${String(props.disableHours)} hours. Owners get an email, and you can cancel until then.`}
          submit={dialog === 'on' ? 'Switch on' : 'Schedule switch-off'}
          danger={dialog === 'off'}
          onClose={() => { setDialog(null); }}
          onSubmit={async (h) => { await props.onSet(dialog === 'on', h); }}
        />
      )}
    </div>
  );
}

/** "address,label" per line; a header line and blank lines are skipped. */
function parseCsv(text: string): { address: string; label: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^address\b/i.test(l))
    .map((l) => {
      const [address = '', ...rest] = l.split(/[,;\t]/);
      return { address: address.trim().replace(/^"|"$/g, ''), label: rest.join(' ').trim().replace(/^"|"$/g, '').slice(0, 60) };
    });
}

export function WhitelistAddresses(props: { livemode: boolean; canManage: boolean; totp: boolean }) {
  const state = useLoad(() => api<WhitelistState>('GET', `/security/whitelist/?livemode=${String(props.livemode)}`), [props.livemode]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useLoad(() => api<{ data: WhitelistedAddress[] }>('GET', `/security/whitelist/addresses?livemode=${String(props.livemode)}${query ? `&q=${encodeURIComponent(query)}` : ''}`), [props.livemode, query]);
  const [manual, setManual] = useState(false);
  const [form, setForm] = useState({ address: '', label: '' });
  const [csv, setCsv] = useState<{ name: string; rows: { address: string; label: string }[] }>();
  const [result, setResult] = useState<{ added: number; skipped: number; invalid: { address: string; reason: string }[] }>();
  const file = useRef<HTMLInputElement>(null);
  const remove = useAction();
  const reload = () => {
    state.reload();
    list.reload();
  };
  const add = async (entries: { address: string; label: string }[], h: Record<string, string>) => {
    const r = await api<{ added: WhitelistedAddress[]; skipped: number; invalid: { address: string; reason: string }[] }>('POST', '/security/whitelist/addresses', { livemode: props.livemode, entries }, h);
    setResult({ added: r.added.length, skipped: r.skipped, invalid: r.invalid });
    if (r.added.length > 0) toast.success(`${String(r.added.length)} address${r.added.length === 1 ? '' : 'es'} whitelisted`, props.livemode ? `Usable in ${String(s?.activation_hours ?? 24)} h.` : 'Usable now.');
    reload();
  };
  const s = state.data;

  return (
    <section>
      <header className="page-head"><h2>Whitelist addresses</h2></header>
      <p className="lede-sm">
        Payouts to your users go only to addresses on this list while it is on. New addresses become usable {String(s?.activation_hours ?? 24)} hours after
        you add them; switching the whitelist off takes {String(s?.disable_hours ?? 48)} hours.
      </p>
      {!props.totp && props.canManage && <Needs2fa />}
      <ErrorBox error={state.error} />
      {s && (
        <SwitchCard
          title="Payout address whitelisting"
          on={s.addresses.enabled}
          disableAt={s.addresses.disable_at}
          disableHours={s.disable_hours}
          canManage={props.canManage}
          totp={props.totp}
          onHint={`${String(s.addresses.active)} active${s.addresses.pending > 0 ? `, ${String(s.addresses.pending)} pending` : ''}. Payouts to any other address are refused.`}
          offHint="Payouts can go to any valid address. Switch it on once your trusted addresses are listed."
          onSet={async (enabled, h) => {
            await api('PUT', '/security/whitelist/addresses', { livemode: props.livemode, enabled }, h);
            toast.success(enabled ? 'Whitelist on' : 'Switch-off scheduled');
            reload();
          }}
        />
      )}

      {props.canManage && props.totp && (
        <div className="card wl-add">
          <div>
            <h3>Add a new address to the whitelist</h3>
            <p className="muted">One at a time, or many from a CSV file: one <code>address,label</code> per line.</p>
          </div>
          <div className="row">
            <button type="button" onClick={() => { setManual(true); }}><Icon name="plus" size={16} />Add manually</button>
            <button type="button" className="secondary" onClick={() => { file.current?.click(); }}><Icon name="download" size={16} />Upload CSV file</button>
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 200_000) {
                  toast.error('File too large', 'Up to 500 addresses per file.');
                  return;
                }
                void f.text().then((t) => {
                  const rows = parseCsv(t);
                  if (rows.length === 0) toast.error('No addresses found', 'Expected one address,label per line.');
                  else if (rows.length > 500) toast.error('Too many addresses', 'Up to 500 per file.');
                  else setCsv({ name: f.name, rows });
                });
              }}
            />
          </div>
        </div>
      )}
      {result && (
        <Alert tone={result.invalid.length > 0 ? 'warning' : 'success'}>
          <strong>{result.added} added</strong>{result.skipped > 0 ? `, ${String(result.skipped)} already listed` : ''}{result.invalid.length > 0 ? `, ${String(result.invalid.length)} refused:` : '.'}
          {result.invalid.length > 0 && (
            <ul className="refused">{result.invalid.slice(0, 8).map((i) => <li key={i.address}><code>{i.address || '(empty)'}</code> {i.reason}</li>)}</ul>
          )}
        </Alert>
      )}

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input value={q} onChange={(e) => { setQ(e.target.value); }} placeholder="Search by address or label" aria-label="Search" />
        <button type="submit" className="secondary"><Icon name="search" size={16} />Search</button>
      </form>
      <ErrorBox error={list.error ?? remove.error} />
      {!list.data && !list.error && <Skeleton />}
      {list.data?.data.length === 0 && (
        <EmptyState icon="shield" title={query ? 'No address matches' : 'There are no addresses in the whitelist yet'}>
          {query ? 'Try another address or label.' : 'Add the wallets your payouts may go to.'}
        </EmptyState>
      )}
      {list.data && list.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Requested at</th><th>Network</th><th>Address</th><th>Label</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.data.map((a) => (
                <tr key={a.id}>
                  <td title={fmtDate(a.created_at)}>{ago(a.created_at)}</td>
                  <td><span className="net-chip">EVM · any token</span></td>
                  <td><div className="fp-ip"><code title={a.address}>{short(a.address, 8)}</code><CopyButton value={a.address} /></div></td>
                  <td>{a.label || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${a.status === 'active' ? 's-active' : 's-pending'}`}>{a.status}</span>
                    {a.status === 'pending' && <small className="muted"> from {fmtDate(a.activates_at)}</small>}
                  </td>
                  <td>
                    {props.canManage && (
                      <ConfirmButton
                        label="Remove"
                        confirm="Remove this address from the whitelist?"
                        message={`${a.address} can no longer receive payouts while the whitelist is on. Adding it back restarts the wait.`}
                        disabled={remove.busy}
                        onConfirm={() => { void remove.run(async () => { await api('POST', `/security/whitelist/addresses/${a.id}/remove`); toast.success('Address removed'); reload(); }); }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manual && (
        <TotpDialog
          title="Whitelist an address"
          submit="Add address"
          onClose={() => { setManual(false); setForm({ address: '', label: '' }); }}
          onSubmit={async (h) => { await add([{ address: form.address.trim(), label: form.label.trim() }], h); setForm({ address: '', label: '' }); }}
        >
          <Field label="Address" hint="EVM address (0x…). It covers every token on EVM networks."><input value={form.address} onChange={(e) => { setForm({ ...form, address: e.target.value }); }} placeholder="0x…" spellCheck={false} required data-autofocus /></Field>
          <Field label="Label"><input value={form.label} onChange={(e) => { setForm({ ...form, label: e.target.value }); }} maxLength={60} placeholder="e.g. Exchange hot wallet" /></Field>
        </TotpDialog>
      )}
      {csv && (
        <TotpDialog title={`Import ${csv.name}`} submit={`Add ${String(csv.rows.length)} address${csv.rows.length === 1 ? '' : 'es'}`} onClose={() => { setCsv(undefined); }} onSubmit={async (h) => { await add(csv.rows, h); }}>
          <p>{csv.rows.length} line{csv.rows.length === 1 ? '' : 's'} found. Invalid addresses and ones already listed are reported back, the rest are added.</p>
          <ul className="csv-preview">
            {csv.rows.slice(0, 5).map((r, i) => <li key={i}><code>{r.address}</code>{r.label && <span className="muted"> {r.label}</span>}</li>)}
            {csv.rows.length > 5 && <li className="muted">… and {csv.rows.length - 5} more</li>}
          </ul>
        </TotpDialog>
      )}
    </section>
  );
}

export function WhitelistIps(props: { livemode: boolean; canManage: boolean; totp: boolean }) {
  const state = useLoad(() => api<WhitelistState>('GET', `/security/whitelist/?livemode=${String(props.livemode)}`), [props.livemode]);
  const [draft, setDraft] = useState<{ cidr: string; label: string }[] | null>(null);
  const [form, setForm] = useState({ cidr: '', label: '' });
  const [saving, setSaving] = useState(false);
  const s = state.data;
  if (state.error) return <section><ErrorBox error={state.error} /></section>;
  if (!s) return <section><Skeleton /></section>;
  const entries = draft ?? s.ips.entries;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(s.ips.entries);
  const me = s.request_ip;
  const addEntry = (cidr: string, label: string) => {
    const c = cidr.trim().toLowerCase();
    if (!c || entries.some((e) => e.cidr === c)) return;
    setDraft([...entries, { cidr: c, label: label.trim() }]);
  };

  return (
    <section>
      <header className="page-head"><h2>Whitelist IPs</h2></header>
      <p className="lede-sm">
        While on, your secret API keys only work from these addresses: a stolen key is useless anywhere else. Publishable keys run in browsers and are
        not affected. Switching it off takes {s.disable_hours} hours.
      </p>
      {!props.totp && props.canManage && <Needs2fa />}
      <SwitchCard
        title="API IP whitelisting"
        on={s.ips.enabled}
        disableAt={s.ips.disable_at}
        disableHours={s.disable_hours}
        canManage={props.canManage}
        totp={props.totp}
        canEnable={s.ips.entries.length > 0}
        onHint={`${String(s.ips.entries.length)} address${s.ips.entries.length === 1 ? '' : 'es'} allowed. Requests from anywhere else get 403.`}
        offHint={s.ips.entries.length === 0 ? 'Add your servers below, save, then switch it on.' : 'Secret keys work from any IP. Switch it on to lock them to the list.'}
        onSet={async (enabled, h) => {
          await api('PUT', '/security/whitelist/ips', { enabled }, h);
          toast.success(enabled ? 'IP whitelist on' : 'Switch-off scheduled');
          state.reload();
        }}
      />
      <div className="card">
        <div className="ip-me">
          <div>
            <strong>Your address</strong> <code>{me}</code>
            <div className="muted">This is the dashboard connection. Add your servers' outgoing IPs; the API key pages show where each key is used from.</div>
          </div>
        </div>
        {entries.length === 0 ? (
          <p className="muted">No addresses yet.</p>
        ) : (
          <ul className="ip-list">
            {entries.map((e) => (
              <li key={e.cidr}>
                <code>{e.cidr}</code>
                <span className="muted">{e.label || 'No label'}</span>
                {props.canManage && (
                  <button type="button" className="ghost icon-only" aria-label={`Remove ${e.cidr}`} title="Remove" onClick={() => { setDraft(entries.filter((x) => x.cidr !== e.cidr)); }}>
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {props.canManage && props.totp && (
          <form
            className="ip-form"
            onSubmit={(e) => {
              e.preventDefault();
              addEntry(form.cidr, form.label);
              setForm({ cidr: '', label: '' });
            }}
          >
            <input value={form.cidr} onChange={(e) => { setForm({ ...form, cidr: e.target.value }); }} placeholder="203.0.113.7 or 203.0.113.0/24" aria-label="IP address or CIDR" spellCheck={false} required />
            <input value={form.label} onChange={(e) => { setForm({ ...form, label: e.target.value }); }} placeholder="Label, e.g. Production" aria-label="Label" maxLength={60} />
            <button type="submit" className="secondary"><Icon name="plus" size={16} />Add</button>
          </form>
        )}
        {s.ips.enabled && dirty && entries.length === 0 && <Alert tone="warning">The list cannot be empty while the whitelist is on.</Alert>}
        {dirty && (
          <div className="row end">
            <button type="button" className="ghost" onClick={() => { setDraft(null); }}>Discard</button>
            <button type="button" onClick={() => { setSaving(true); }}>Save changes</button>
          </div>
        )}
      </div>
      {saving && (
        <TotpDialog
          title="Save the IP whitelist"
          message={s.ips.enabled ? 'Applies to every secret key at once.' : 'Saved now; it restricts keys once switched on.'}
          submit="Save"
          onClose={() => { setSaving(false); }}
          onSubmit={async (h) => {
            await api('PUT', '/security/whitelist/ips', { entries }, h);
            setDraft(null);
            toast.success('IP whitelist saved');
            state.reload();
          }}
        />
      )}
    </section>
  );
}
