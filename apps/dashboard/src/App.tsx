import { useEffect, useState } from 'react';
import { ApiError, api, type Me } from './api';
import { Login, ResetPassword, VerifyBanner, VerifyEmail, linkToken } from './auth';
import { ApiKeys, Webhooks } from './developers';
import { InvoiceDetail, Invoices } from './invoices';
import { Sellers } from './sellers';
import { PayoutWallet } from './payout-wallet';
import { ApiKeyDetail } from './key-analytics';
import { Overview } from './overview';
import { SettingsHub } from './settings-hub';
import { AcceptInvite } from './team';
import { Withdrawals } from './withdrawals';
import { UserDeposits } from './deposits';
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

export function App() {
  const [me, setMe] = useState<Me | null>();
  const [error, setError] = useState<string>();
  // Live only: mainnets (BNB Smart Chain, plus Ethereum and Polygon PoS once turned on, D-112); test mode is not offered.
  const livemode = true;
  const hash = useHash();

  const loadMe = () => {
    api<Me>('GET', '/auth/me').then(setMe, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setError(errorText(e));
    });
  };
  useEffect(loadMe, []);

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
    { href: '#/overview', label: 'Overview', icon: 'trend', show: true, group: 'Payments' },
    { href: '#/invoices', label: 'Invoices', icon: 'invoice', show: true, group: 'Payments' },
    { href: '#/sellers', label: 'Sellers', icon: 'store', show: true, group: 'Payments' },
    // Users' permanent deposit addresses (D-101), for web3 projects.
    { href: '#/deposits', label: 'User deposits', icon: 'users', show: true, group: 'Payments' },
    // Payout wallet: where the merchant turns custody on or off (D-098). Custody on: they withdraw what we hold for them;
    // off: payments go straight into their own wallet.
    { href: '#/xpub', label: 'Payout wallet', icon: 'wallet', show: true, group: 'Payments' },
    { href: '#/withdrawals', label: 'Withdrawals', icon: 'coins', show: custodial, group: 'Payments' },
    { href: '#/api-keys', label: 'API keys', icon: 'key', show: dev, group: 'Developers' },
    { href: '#/webhooks', label: 'Webhooks', icon: 'zap', show: dev, group: 'Developers' },
    // Every account setting in one place (D-110): security, team, whitelists, payout wallet, widget.
    { href: '#/settings', label: 'Settings', icon: 'sliders', show: true, group: 'Account' },
  ];
  const [, rawPage = 'overview', id] = hash.split('/');
  // Older links (emails, bookmarks) to pages that now live in Settings.
  const LEGACY: Record<string, string> = { security: 'security', team: 'team', widget: 'widget' };
  const legacy = LEGACY[rawPage];
  const page = legacy ? 'settings' : rawPage || 'overview';
  const section = legacy ?? id;
  const current = nav.find((n) => n.href === `#/${page}`) ?? nav[0];

  let body;
  if (page === 'overview') body = <Overview livemode={livemode} me={me} />;
  else if (page === 'invoices' && id) body = <InvoiceDetail id={id} canWrite={role !== 'read_only'} />;
  else if (page === 'sellers') body = <Sellers livemode={livemode} canWrite={role !== 'read_only'} />;
  else if (page === 'deposits') body = <UserDeposits livemode={livemode} />;
  else if (page === 'api-keys' && dev && id) body = <ApiKeyDetail id={id} canManage={role === 'owner'} />;
  else if (page === 'api-keys' && dev) body = <ApiKeys livemode={livemode} totp={totp} />;
  else if (page === 'webhooks' && dev) body = <Webhooks livemode={livemode} totp={totp} />;
  else if (page === 'xpub') body = <PayoutWallet livemode={livemode} canManage={role === 'owner'} totp={totp} onModeChange={loadMe} />;
  else if (page === 'withdrawals' && custodial) body = <Withdrawals livemode={livemode} enabled={me.merchant.withdrawals_enabled} canRequest={role === 'owner' || role === 'finance'} canManageAddress={role === 'owner'} totp={totp} />;
  else if (page === 'settings') body = <SettingsHub section={section} me={me} livemode={livemode} onChange={loadMe} />;
  else if (page === 'invoices') body = <Invoices livemode={livemode} canWrite={role !== 'read_only'} canExport={role !== 'developer'} />;
  else body = <Overview livemode={livemode} me={me} />;

  return (
    <div className="app live">
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
        <header className="topbar">
          <div className="title">
            <span className="workspace">{me.merchant.name}</span>
            <span className="mode-pill live">Live</span>
          </div>
        </header>
        <main>
          {!me.user.email_verified && <VerifyBanner />}
          {!totp && !(page === 'settings' && section === 'security') && (
            <Alert tone="warning">
              Protect your account: <a href="#/settings/security">enable two-factor authentication</a>. It is required for API keys, webhooks, payout wallet and team changes.
            </Alert>
          )}
          {body}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
