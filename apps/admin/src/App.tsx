import { useEffect, useRef, useState } from 'react';
import { Alert, BrandMark, ErrorBox, Field, Icon, Submit, Toaster, TotpInput, errorText, useAction, type IconName } from '../../dashboard/src/ui';
import { ApiError, api, setUnauthorizedHandler, type Admin } from './api';
import { Admins, Audit, BlockedPayers, Custody, InvoiceDetail, Invoices, MerchantDetail, Merchants, Registry, Settings, WithdrawalQueue } from './pages';

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

/** `ended`: the session ran out (idle or absolute limit, D-106) while the console was open. */
function Login(props: { onDone: (a: Admin) => void; ended: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Ask for the code unless the server says login skips it (development only).
  const [totp, setTotp] = useState(true);
  useEffect(() => {
    api<{ totp_required: boolean }>('GET', '/auth/options').then((o) => {
      setTotp(o.totp_required);
    }, () => undefined);
  }, []);
  const a = useAction();
  return (
    <div className="auth-solo">
      <form
        className="auth card glow"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api<{ admin: Admin }>('POST', '/auth/login', totp ? { email, password, code } : { email, password });
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
        {props.ended && <Alert tone="info">Your session ended after a period of inactivity. Sign in again to pick up where you left off.</Alert>}
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" placeholder="you@company.com" autoFocus required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="current-password" placeholder="••••••••••••" required />
        </Field>
        {totp && <TotpInput value={code} onChange={setCode} />}
        <ErrorBox error={a.error} />
        <Submit busy={a.busy}>Sign in</Submit>
      </form>
    </div>
  );
}

export function App() {
  const [admin, setAdmin] = useState<Admin | null>();
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);
  const signedIn = useRef(false);
  const hash = useHash();

  useEffect(() => {
    signedIn.current = Boolean(admin);
  }, [admin]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // A 401 while signed in = the session ran out; the first /auth/me of a visit is just "not signed in".
      if (signedIn.current) setEnded(true);
      setAdmin(null);
    });
    api<Admin>('GET', '/auth/me').then(setAdmin, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setAdmin(null);
      else setError(errorText(e));
    });
  }, []);

  if (error) return <div className="auth-solo"><ErrorBox error={error} /></div>;
  if (admin === undefined) return <div className="boot"><BrandMark /></div>;
  if (admin === null) {
    return (
      <Login
        ended={ended}
        onDone={(a) => {
          setEnded(false);
          setAdmin(a);
        }}
      />
    );
  }

  // UI hints only; the server enforces every permission (packages/core/src/rbac.ts).
  const manage = admin.role !== 'auditor';
  const nav: { href: string; label: string; icon: IconName; show: boolean; group: string }[] = [
    { href: '#/merchants', label: 'Merchants', icon: 'store', show: true, group: 'Operations' },
    { href: '#/invoices', label: 'Invoices', icon: 'invoice', show: true, group: 'Operations' },
    { href: '#/withdrawals', label: 'Withdrawals', icon: 'wallet', show: true, group: 'Operations' },
    { href: '#/custody', label: 'Custody', icon: 'lock', show: true, group: 'Operations' },
    { href: '#/registry', label: 'Kill switches', icon: 'power', show: true, group: 'Risk & control' },
    { href: '#/risk', label: 'Blocked payers', icon: 'shield', show: true, group: 'Risk & control' },
    { href: '#/audit', label: 'Audit log', icon: 'list', show: admin.role !== 'operator', group: 'Risk & control' },
    { href: '#/admins', label: 'Admins', icon: 'users', show: admin.role === 'superadmin', group: 'Platform' },
    { href: '#/settings', label: 'Settings', icon: 'sliders', show: true, group: 'Platform' },
  ];
  const groups = [...new Set(nav.map((n) => n.group))];
  const [path = '', query = ''] = hash.slice(1).split('?');
  const [, page = 'merchants', id] = path.split('/');
  const params = new URLSearchParams(query);

  let body;
  if (page === 'merchants' && id) body = <MerchantDetail id={id} manage={manage} />;
  else if (page === 'invoices' && id) body = <InvoiceDetail id={id} manage={manage} />;
  else if (page === 'invoices') body = <Invoices merchantId={params.get('merchant') ?? undefined} />;
  else if (page === 'withdrawals') body = <WithdrawalQueue selfId={admin.id} canApprove={manage} />;
  else if (page === 'custody') body = <Custody selfId={admin.id} manage={manage} superadmin={admin.role === 'superadmin'} />;
  else if (page === 'registry') body = <Registry manage={manage} superadmin={admin.role === 'superadmin'} />;
  else if (page === 'risk') body = <BlockedPayers manage={manage} />;
  else if (page === 'audit') body = <Audit merchantId={params.get('merchant') ?? undefined} />;
  else if (page === 'admins' && admin.role === 'superadmin') body = <Admins selfId={admin.id} />;
  else if (page === 'settings') body = <Settings superadmin={admin.role === 'superadmin'} />;
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
          {groups.map((g) => (
            <div className="nav-group" key={g}>
              <div className="nav-label">{g}</div>
              <nav>
                {nav.filter((n) => n.show && n.group === g).map((n) => (
                  <a key={n.href} href={n.href} className={current?.href === n.href ? 'active' : ''} aria-current={current?.href === n.href ? 'page' : undefined}>
                    <Icon name={n.icon} />
                    {n.label}
                  </a>
                ))}
              </nav>
            </div>
          ))}
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
              signedIn.current = false;
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
