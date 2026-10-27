import { useEffect, useState } from 'react';
import { ApiError, api, type Me } from './api';
import { Login, ResetPassword, VerifyBanner, VerifyEmail, linkToken } from './auth';
import { ApiKeys, Webhooks } from './developers';
import { InvoiceDetail, Invoices } from './invoices';
import { Security, Xpubs } from './settings';
import { AcceptInvite, Team } from './team';
import { Widget } from './widget';
import { Withdrawals } from './withdrawals';
import { Alert, BrandMark, ErrorBox, Icon, Toaster, errorText, type IconName } from './ui';

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

const MODE_KEY = 'gw_livemode';
function storedMode(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function App() {
  const [me, setMe] = useState<Me | null>();
  const [error, setError] = useState<string>();
  const [livemode, setLivemode] = useState(storedMode);
  const hash = useHash();

  const loadMe = () => {
    api<Me>('GET', '/auth/me').then(setMe, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setError(errorText(e));
    });
  };
  useEffect(loadMe, []);

  const switchMode = (live: boolean) => {
    setLivemode(live);
    try {
      localStorage.setItem(MODE_KEY, String(live));
    } catch {
      // storage unavailable: mode lasts for this page only
    }
  };

  // Emailed links work signed in or out.
  if (hash.startsWith('#/verify-email')) return <VerifyEmail token={linkToken(hash)} onDone={loadMe} />;
  if (hash.startsWith('#/reset-password')) return <ResetPassword token={linkToken(hash)} />;
  if (hash.startsWith('#/accept-invite')) return <AcceptInvite token={linkToken(hash)} onDone={loadMe} />;
  if (error) return <div className="auth-solo"><ErrorBox error={error} /></div>;
  if (me === undefined) return <div className="boot"><BrandMark /></div>;
  if (me === null) return <><Login onDone={loadMe} /><Toaster /></>;

  // UI hints only; the server enforces every permission (packages/core/src/rbac.ts).
  const role = me.user.role;
  const dev = role === 'owner' || role === 'admin' || role === 'developer';
  const totp = me.user.totp_enabled;
  const custodial = me.merchant.custody_mode === 'custodial';
  const nav: { href: string; label: string; icon: IconName; show: boolean; group: 'Payments' | 'Developers' | 'Account' }[] = [
    { href: '#/invoices', label: 'Invoices', icon: 'invoice', show: true, group: 'Payments' },
    // Custodial accounts withdraw what we hold for them; non-custodial ones are paid straight into their own wallet.
    { href: '#/withdrawals', label: 'Withdrawals', icon: 'wallet', show: custodial, group: 'Payments' },
    { href: '#/xpub', label: 'Payout wallet', icon: 'wallet', show: !custodial, group: 'Payments' },
    { href: '#/api-keys', label: 'API keys', icon: 'key', show: dev, group: 'Developers' },
    { href: '#/webhooks', label: 'Webhooks', icon: 'zap', show: dev, group: 'Developers' },
    { href: '#/widget', label: 'Checkout widget', icon: 'widget', show: dev, group: 'Developers' },
    { href: '#/team', label: 'Team', icon: 'users', show: true, group: 'Account' },
    { href: '#/security', label: 'Security', icon: 'shield', show: true, group: 'Account' },
  ];
  const [, page = 'invoices', id] = hash.split('/');
  const current = nav.find((n) => n.href === `#/${page}`) ?? nav[0];

  let body;
  if (page === 'invoices' && id) body = <InvoiceDetail id={id} canWrite={role !== 'read_only'} />;
  else if (page === 'api-keys' && dev) body = <ApiKeys livemode={livemode} totp={totp} />;
  else if (page === 'webhooks' && dev) body = <Webhooks livemode={livemode} totp={totp} />;
  else if (page === 'xpub') body = <Xpubs livemode={livemode} canManage={role === 'owner'} totp={totp} custodyMode={me.merchant.custody_mode} />;
  else if (page === 'withdrawals' && custodial) body = <Withdrawals livemode={livemode} canRequest={role === 'owner' || role === 'finance'} canManageAddress={role === 'owner'} totp={totp} />;
  else if (page === 'security') body = <Security totp={totp} onChange={loadMe} />;
  else if (page === 'team') body = <Team me={me.user} totp={totp} />;
  else if (page === 'widget' && dev) body = <Widget canManage={role === 'owner' || role === 'admin'} apiOrigin={me.api_origin} />;
  else body = <Invoices livemode={livemode} canWrite={role !== 'read_only'} canExport={role !== 'developer'} />;

  return (
    <div className={livemode ? 'app live' : 'app test'}>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            Gateway
            <small>Merchant dashboard</small>
          </div>
        </div>
        <div className="nav-groups">
          {(['Payments', 'Developers', 'Account'] as const).map((group) => {
            const items = nav.filter((n) => n.show && n.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="nav-group">
                <div className="nav-label">{group}</div>
                <nav>
                  {items.map((n) => (
                    <a key={n.href} href={n.href} className={current?.href === n.href ? 'active' : ''} aria-current={current?.href === n.href ? 'page' : undefined}>
                      <Icon name={n.icon} />
                      {n.label}
                    </a>
                  ))}
                </nav>
              </div>
            );
          })}
        </div>
        <div className="spacer" />
        <div className="user-card">
          <span className="avatar" aria-hidden="true">{me.user.email.slice(0, 1).toUpperCase()}</span>
          <div className="who">
            <div title={me.user.email}>{me.user.email}</div>
            <small>{role.replace('_', ' ')}</small>
          </div>
          <button
            type="button"
            className="ghost icon-only"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              void api('POST', '/auth/logout').finally(() => {
                setMe(null);
              });
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="shell-main">
        {!livemode && <div className="test-banner">You are in test mode: testnet tokens only, no real funds move.</div>}
        <header className="topbar">
          <div className="title">
            <span className="workspace">{me.merchant.name}</span>
            <span className={`mode-pill ${livemode ? 'live' : 'test'}`}>{livemode ? 'Live' : 'Test'}</span>
          </div>
          <div className="mode" role="group" aria-label="Mode">
            <button className={livemode ? '' : 'on'} aria-pressed={!livemode} onClick={() => { switchMode(false); }}>Test</button>
            <button className={livemode ? 'on' : ''} aria-pressed={livemode} onClick={() => { switchMode(true); }}>Live</button>
          </div>
        </header>
        <main>
          {!me.user.email_verified && <VerifyBanner />}
          {!totp && page !== 'security' && (
            <Alert tone="warning">
              Protect your account: <a href="#/security">enable two-factor authentication</a>. It is required for API keys, webhooks, payout wallet and team changes.
            </Alert>
          )}
          {/* key: switching mode remounts the page so no state from the other mode leaks into forms or lists */}
          <div key={String(livemode)}>{body}</div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
