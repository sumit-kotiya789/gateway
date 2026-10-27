import { useEffect, useState } from 'react';
import { BrandMark, ErrorBox, Field, Icon, Submit, Toaster, TotpInput, errorText, useAction, type IconName } from '../../dashboard/src/ui';
import { ApiError, api, setUnauthorizedHandler, type Admin } from './api';
import { Admins, Audit, InvoiceDetail, Invoices, MerchantDetail, Merchants, Registry } from './pages';

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
    <div className="auth-solo">
      <form
        className="auth card glow"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api<{ admin: Admin }>('POST', '/auth/login', { email, password, code });
            props.onDone(r.admin);
          });
        }}
      >
        <div className="brand">
          <BrandMark />
          <div>
            Gateway
            <small>Admin console</small>
          </div>
        </div>
        <h1>Operator sign in</h1>
        <p className="lede">Every action here is recorded in the audit log.</p>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" placeholder="you@company.com" autoFocus required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="current-password" placeholder="••••••••••••" required />
        </Field>
        <TotpInput value={code} onChange={setCode} />
        <ErrorBox error={a.error} />
        <Submit busy={a.busy}>Sign in</Submit>
      </form>
    </div>
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

  if (error) return <div className="auth-solo"><ErrorBox error={error} /></div>;
  if (admin === undefined) return <div className="boot"><BrandMark /></div>;
  if (admin === null) return <Login onDone={setAdmin} />;

  // UI hints only; the server enforces every permission (packages/core/src/rbac.ts).
  const manage = admin.role !== 'auditor';
  const nav: { href: string; label: string; icon: IconName; show: boolean }[] = [
    { href: '#/merchants', label: 'Merchants', icon: 'store', show: true },
    { href: '#/invoices', label: 'Invoices', icon: 'invoice', show: true },
    { href: '#/registry', label: 'Kill switches', icon: 'power', show: true },
    { href: '#/audit', label: 'Audit log', icon: 'list', show: admin.role !== 'operator' },
    { href: '#/admins', label: 'Admins', icon: 'users', show: admin.role === 'superadmin' },
  ];
  const [path = '', query = ''] = hash.slice(1).split('?');
  const [, page = 'merchants', id] = path.split('/');
  const params = new URLSearchParams(query);

  let body;
  if (page === 'merchants' && id) body = <MerchantDetail id={id} manage={manage} />;
  else if (page === 'invoices' && id) body = <InvoiceDetail id={id} manage={manage} />;
  else if (page === 'invoices') body = <Invoices merchantId={params.get('merchant') ?? undefined} />;
  else if (page === 'registry') body = <Registry manage={manage} superadmin={admin.role === 'superadmin'} />;
  else if (page === 'audit') body = <Audit merchantId={params.get('merchant') ?? undefined} />;
  else if (page === 'admins' && admin.role === 'superadmin') body = <Admins selfId={admin.id} />;
  else body = <Merchants />;

  const current = nav.find((n) => n.href === `#/${page}`) ?? nav[0];

  return (
    <div className="app live">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            Gateway
            <small>Admin console</small>
          </div>
        </div>
        <div className="nav-groups">
          <div className="nav-group">
            <div className="nav-label">Operations</div>
            <nav>
              {nav.filter((n) => n.show).map((n) => (
                <a key={n.href} href={n.href} className={current?.href === n.href ? 'active' : ''} aria-current={current?.href === n.href ? 'page' : undefined}>
                  <Icon name={n.icon} />
                  {n.label}
                </a>
              ))}
            </nav>
          </div>
        </div>
        <div className="spacer" />
        <div className="user-card">
          <span className="avatar" aria-hidden="true">{admin.role.slice(0, 1).toUpperCase()}</span>
          <div className="who">
            <div>Platform staff</div>
            <small>{admin.role}</small>
          </div>
          <button
            type="button"
            className="ghost icon-only"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              void api('POST', '/auth/logout').finally(() => {
                setAdmin(null);
              });
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <div className="title">
            <span className="workspace">{current?.label}</span>
            <span className="mode-pill live">{admin.role}</span>
          </div>
        </header>
        <main key={hash}>{body}</main>
      </div>
      <Toaster />
    </div>
  );
}
