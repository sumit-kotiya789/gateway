import { useEffect, useState } from 'react';
import { ErrorBox, Field, TotpInput, errorText, useAction } from '../../dashboard/src/ui';
import { ApiError, api, setUnauthorizedHandler, type Admin } from './api';
import { Audit, InvoiceDetail, Invoices, MerchantDetail, Merchants, Registry } from './pages';

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
    };
    addEventListener('hashchange', on);
    return () => {
      removeEventListener('hashchange', on);
    };
  }, []);
  return hash;
}

function Login(props: { onDone: (a: Admin) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  return (
    <form
      className="auth card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          const r = await api<{ admin: Admin }>('POST', '/auth/login', { email, password, code });
          props.onDone(r.admin);
        });
      }}
    >
      <h1>Gateway admin</h1>
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" autoFocus required />
      </Field>
      <Field label="Password">
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="current-password" required />
      </Field>
      <TotpInput value={code} onChange={setCode} />
      <ErrorBox error={a.error} />
      <button disabled={a.busy}>Sign in</button>
    </form>
  );
}

export function App() {
  const [admin, setAdmin] = useState<Admin | null>();
  const [error, setError] = useState<string>();
  const hash = useHash();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdmin(null);
    });
    api<Admin>('GET', '/auth/me').then(setAdmin, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setAdmin(null);
      else setError(errorText(e));
    });
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (admin === undefined) return <p className="muted center">Loading…</p>;
  if (admin === null) return <Login onDone={setAdmin} />;

  // UI hints only; the server enforces every permission (packages/core/src/rbac.ts).
  const manage = admin.role !== 'auditor';
  const nav = [
    ['#/merchants', 'Merchants', true],
    ['#/invoices', 'Invoices', true],
    ['#/registry', 'Kill switches', true],
    ['#/audit', 'Audit log', admin.role !== 'operator'],
  ] as const;
  const [path = '', query = ''] = hash.slice(1).split('?');
  const [, page = 'merchants', id] = path.split('/');
  const params = new URLSearchParams(query);

  let body;
  if (page === 'merchants' && id) body = <MerchantDetail id={id} manage={manage} />;
  else if (page === 'invoices' && id) body = <InvoiceDetail id={id} manage={manage} />;
  else if (page === 'invoices') body = <Invoices merchantId={params.get('merchant') ?? undefined} />;
  else if (page === 'registry') body = <Registry manage={manage} superadmin={admin.role === 'superadmin'} />;
  else if (page === 'audit') body = <Audit merchantId={params.get('merchant') ?? undefined} />;
  else body = <Merchants />;

  return (
    <div className="app live">
      <header className="topbar">
        <strong className="brand">Gateway admin</strong>
        <span className="muted">{admin.role}</span>
        <button
          className="secondary"
          onClick={() => {
            void api('POST', '/auth/logout').finally(() => {
              setAdmin(null);
            });
          }}
        >
          Sign out
        </button>
      </header>
      <div className="layout">
        <nav>
          {nav.filter(([, , show]) => show).map(([href, label]) => (
            <a key={href} href={href} className={`#/${page}` === href ? 'active' : ''}>{label}</a>
          ))}
        </nav>
        <main key={hash}>{body}</main>
      </div>
    </div>
  );
}
