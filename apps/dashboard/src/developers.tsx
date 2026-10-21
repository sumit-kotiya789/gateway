import { useState } from 'react';
import { api, totpHeader, type ApiKey, type WebhookEndpoint } from './api';
import { ConfirmButton, ErrorBox, Field, SecretOnce, TotpInput, fmtDate, useAction, useLoad } from './ui';

const SECRET_SCOPES = ['read', 'invoices:write', 'refunds:write', 'withdrawals:write', 'webhooks:write'];

const Needs2fa = () => (
  <p className="notice">
    Creating this needs two-factor authentication. <a href="#/security">Enable it in Security.</a>
  </p>
);

function keyState(k: ApiKey): string {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return 'expired';
  return 'active';
}

export function ApiKeys(props: { livemode: boolean; totp: boolean }) {
  const keys = useLoad(() => api<{ data: ApiKey[] }>('GET', '/api-keys/'), []);
  const [created, setCreated] = useState<string>();
  const [form, setForm] = useState({ name: '', kind: 'secret' as 'secret' | 'publishable', scopes: ['read', 'invoices:write'], code: '' });
  const a = useAction();
  const revoke = useAction();
  const rows = (keys.data?.data ?? []).filter((k) => k.livemode === props.livemode);
  const toggleScope = (s: string) => {
    setForm({ ...form, scopes: form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s] });
  };

  return (
    <section>
      <header className="page-head"><h2>API keys</h2></header>
      <ErrorBox error={keys.error} />
      {created && <SecretOnce label="Your new API key" value={created} onDone={() => { setCreated(undefined); }} />}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th>Created</th><th>State</th><th /></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code>{k.prefix}…</code></td>
                  <td>{k.scopes.join(', ')}</td>
                  <td>{fmtDate(k.last_used_at)}</td>
                  <td>{fmtDate(k.created_at)}</td>
                  <td>{keyState(k)}</td>
                  <td>
                    {keyState(k) === 'active' && (
                      <ConfirmButton
                        label="Revoke"
                        confirm="Confirm revoke"
                        disabled={revoke.busy}
                        onConfirm={() => { void revoke.run(async () => { await api('DELETE', `/api-keys/${k.id}`); keys.reload(); }); }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        keys.data && <p className="muted">No {props.livemode ? 'live' : 'test'} keys.</p>
      )}
      <ErrorBox error={revoke.error} />

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api<{ key: string }>(
              'POST',
              '/api-keys/',
              { name: form.name.trim(), kind: form.kind, livemode: props.livemode, ...(form.kind === 'secret' ? { scopes: form.scopes } : {}) },
              totpHeader(form.code),
            );
            setCreated(r.key);
            setForm({ ...form, name: '', code: '' });
            keys.reload();
          });
        }}
      >
        <h3>Create {props.livemode ? 'live' : 'test'} key</h3>
        {!props.totp && <Needs2fa />}
        <div className="grid">
          <Field label="Name">
            <input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} maxLength={100} required />
          </Field>
          <Field label="Type" hint={form.kind === 'publishable' ? 'Safe for browsers; checkout only.' : 'Server-side only. Never ship it to a browser.'}>
            <select value={form.kind} onChange={(e) => { setForm({ ...form, kind: e.target.value as 'secret' | 'publishable' }); }}>
              <option value="secret">Secret</option>
              <option value="publishable">Publishable</option>
            </select>
          </Field>
        </div>
        {form.kind === 'secret' && (
          <fieldset className="scopes">
            <legend>Scopes</legend>
            {SECRET_SCOPES.map((s) => (
              <label key={s} className="check">
                <input type="checkbox" checked={form.scopes.includes(s)} onChange={() => { toggleScope(s); }} /> {s}
              </label>
            ))}
          </fieldset>
        )}
        <TotpInput value={form.code} onChange={(code) => { setForm({ ...form, code }); }} />
        <ErrorBox error={a.error} />
        <button disabled={a.busy || !props.totp || (form.kind === 'secret' && form.scopes.length === 0)}>Create key</button>
      </form>
    </section>
  );
}

export function Webhooks(props: { livemode: boolean; totp: boolean }) {
  const list = useLoad(() => api<{ data: WebhookEndpoint[] }>('GET', `/webhooks/?livemode=${String(props.livemode)}`), [props.livemode]);
  const [created, setCreated] = useState<string>();
  const [form, setForm] = useState({ url: '', description: '', code: '' });
  const a = useAction();
  const del = useAction();
  const rows = list.data?.data ?? [];

  return (
    <section>
      <header className="page-head"><h2>Webhooks</h2></header>
      <p className="notice">Endpoints are saved now; event delivery is not switched on yet.</p>
      <ErrorBox error={list.error} />
      {created && <SecretOnce label="Signing secret" value={created} onDone={() => { setCreated(undefined); }} />}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>URL</th><th>Description</th><th>Created</th><th /></tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td><code>{w.url}</code></td>
                  <td>{w.description ?? '—'}</td>
                  <td>{fmtDate(w.created_at)}</td>
                  <td>
                    <ConfirmButton
                      label="Delete"
                      confirm="Confirm delete"
                      disabled={del.busy}
                      onConfirm={() => { void del.run(async () => { await api('DELETE', `/webhooks/${w.id}`); list.reload(); }); }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        list.data && <p className="muted">No {props.livemode ? 'live' : 'test'} endpoints.</p>
      )}
      <ErrorBox error={del.error} />

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api<{ secret: string }>(
              'POST',
              '/webhooks/',
              { livemode: props.livemode, url: form.url.trim(), ...(form.description.trim() ? { description: form.description.trim() } : {}) },
              totpHeader(form.code),
            );
            setCreated(r.secret);
            setForm({ url: '', description: '', code: '' });
            list.reload();
          });
        }}
      >
        <h3>Add {props.livemode ? 'live' : 'test'} endpoint</h3>
        {!props.totp && <Needs2fa />}
        <Field label="Endpoint URL" hint="https:// in production.">
          <input type="url" value={form.url} onChange={(e) => { setForm({ ...form, url: e.target.value }); }} maxLength={2000} placeholder="https://shop.example/webhooks/gateway" required />
        </Field>
        <Field label="Description (optional)">
          <input value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); }} maxLength={200} />
        </Field>
        <TotpInput value={form.code} onChange={(code) => { setForm({ ...form, code }); }} />
        <ErrorBox error={a.error} />
        <button disabled={a.busy || !props.totp}>Add endpoint</button>
      </form>
    </section>
  );
}
