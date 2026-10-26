import { useState } from 'react';
import { api, totpHeader, type Role } from './api';
import { ConfirmButton, ErrorBox, Field, TotpInput, fmtDate, useAction, useLoad } from './ui';

interface Member {
  id: string;
  email: string;
  role: Role;
  totp_enabled: boolean;
  email_verified: boolean;
  created_at: string;
}
interface Invite {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
}

const ROLES: Role[] = ['owner', 'admin', 'developer', 'finance', 'read_only'];
const label = (r: string) => r.replace('_', ' ');
/** UI hint matching the server rule: owners manage every role, admins the non-privileged ones. */
const manageable = (me: Role, r: Role) => me === 'owner' || (me === 'admin' && r !== 'owner' && r !== 'admin');

export function Team(props: { me: { id: string; role: Role }; totp: boolean }) {
  const team = useLoad(() => api<{ members: Member[]; invites: Invite[] }>('GET', '/team/'), []);
  const canManage = props.me.role === 'owner' || props.me.role === 'admin';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [code, setCode] = useState('');
  const a = useAction();
  const run = (fn: () => Promise<unknown>) =>
    void a.run(async () => {
      await fn();
      setCode('');
      team.reload();
    });

  return (
    <section>
      <header className="page-head"><h2>Team</h2></header>
      <ErrorBox error={team.error} />
      <ErrorBox error={a.error} />
      {canManage && <TotpInput value={code} onChange={setCode} />}
      {canManage && !props.totp && <p className="notice">Managing the team needs two-factor authentication. <a href="#/security">Enable it in Security.</a></p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>2FA</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {(team.data?.members ?? []).map((m) => (
              <tr key={m.id}>
                <td>{m.email}{m.email_verified ? '' : <small className="muted"> (unverified)</small>}</td>
                <td>
                  {canManage && m.id !== props.me.id && manageable(props.me.role, m.role) ? (
                    <select
                      value={m.role}
                      aria-label={`Role of ${m.email}`}
                      disabled={a.busy}
                      onChange={(e) => { run(() => api('POST', `/team/members/${m.id}/role`, { role: e.target.value }, totpHeader(code))); }}
                    >
                      {ROLES.filter((r) => manageable(props.me.role, r)).map((r) => <option key={r} value={r}>{label(r)}</option>)}
                    </select>
                  ) : (
                    label(m.role)
                  )}
                </td>
                <td>{m.totp_enabled ? 'on' : 'off'}</td>
                <td>{fmtDate(m.created_at)}</td>
                <td>
                  {canManage && m.id !== props.me.id && manageable(props.me.role, m.role) && (
                    <ConfirmButton label="Remove" confirm={`Remove ${m.email}?`} disabled={a.busy} onConfirm={() => { run(() => api('DELETE', `/team/members/${m.id}`, undefined, totpHeader(code))); }} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && <p className="muted">Changing a role signs the member out; the new role applies when they sign in again. Enter a fresh code above for each change.</p>}

      {(team.data?.invites ?? []).length > 0 && (
        <>
          <h3>Pending invitations</h3>
          <ul>
            {(team.data?.invites ?? []).map((i) => (
              <li key={i.id}>
                {i.email} · {label(i.role)} · expires {fmtDate(i.expires_at)}{' '}
                {canManage && manageable(props.me.role, i.role) && (
                  <button className="link" disabled={a.busy} onClick={() => { run(() => api('DELETE', `/team/invites/${i.id}`)); }}>Revoke</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {canManage && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api('POST', '/team/invites', { email, role }, totpHeader(code));
              setEmail('');
            });
          }}
        >
          <h3>Invite a member</h3>
          <div className="row">
            <Field label="Email"><input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} required /></Field>
            <Field label="Role">
              <select value={role} onChange={(e) => { setRole(e.target.value as Role); }}>
                {ROLES.filter((r) => manageable(props.me.role, r)).map((r) => <option key={r} value={r}>{label(r)}</option>)}
              </select>
            </Field>
          </div>
          <button disabled={a.busy || !props.totp}>Send invitation</button>
        </form>
      )}
    </section>
  );
}

export function AcceptInvite(props: { token: string; onDone: () => void }) {
  const info = useLoad(() => api<{ merchant_name: string; email: string; role: string }>('POST', '/auth/invite/preview', { token: props.token }), [props.token]);
  const [password, setPassword] = useState('');
  const a = useAction();
  return (
    <form
      className="auth card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api('POST', '/auth/invite/accept', { token: props.token, password });
          location.hash = '#/';
          props.onDone();
        });
      }}
    >
      <h1>Join {info.data?.merchant_name ?? '…'}</h1>
      <ErrorBox error={info.error} />
      {info.data && (
        <>
          <p>You are invited as <strong>{label(info.data.role)}</strong> with <strong>{info.data.email}</strong>. Choose a password to accept.</p>
          <Field label="Password" hint="At least 12 characters.">
            <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="new-password" minLength={12} maxLength={128} autoFocus required />
          </Field>
          <ErrorBox error={a.error} />
          <button disabled={a.busy}>Accept invitation</button>
        </>
      )}
    </form>
  );
}
