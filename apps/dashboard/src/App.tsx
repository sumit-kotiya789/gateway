import { useEffect, useState } from 'react';
import { ApiError, api, type Me } from './api';
import { Login, ResetPassword, VerifyBanner, VerifyEmail, linkToken } from './auth';
import { ApiKeys, Webhooks } from './developers';
import { InvoiceDetail, Invoices } from './invoices';
import { Security, Xpubs } from './settings';
import { AcceptInvite, Team } from './team';
import { Widget } from './widget';
import { ErrorBox, errorText } from './ui';

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
  if (error) return <ErrorBox error={error} />;
  if (me === undefined) return <p className="muted center">Loading…</p>;
  if (me === null) return <Login onDone={loadMe} />;

  // UI hints only; the server enforces every permission (packages/core/src/rbac.ts).
  const role = me.user.role;
  const dev = role === 'owner' || role === 'admin' || role === 'developer';
  const totp = me.user.totp_enabled;
  const nav = [
    ['#/invoices', 'Invoices', true],
    ['#/api-keys', 'API keys', dev],
    ['#/webhooks', 'Webhooks', dev],
    ['#/widget', 'Checkout widget', dev],
    ['#/xpub', 'Payout wallet', true],
    ['#/team', 'Team', true],
    ['#/security', 'Security', true],
  ] as const;
  const [, page = 'invoices', id] = hash.split('/');

  let body;
  if (page === 'invoices' && id) body = <InvoiceDetail id={id} canWrite={role !== 'read_only'} />;
  else if (page === 'api-keys' && dev) body = <ApiKeys livemode={livemode} totp={totp} />;
  else if (page === 'webhooks' && dev) body = <Webhooks livemode={livemode} totp={totp} />;
  else if (page === 'xpub') body = <Xpubs livemode={livemode} canManage={role === 'owner'} totp={totp} custodyMode={me.merchant.custody_mode} />;
  else if (page === 'security') body = <Security totp={totp} onChange={loadMe} />;
  else if (page === 'team') body = <Team me={me.user} totp={totp} />;
  else if (page === 'widget' && dev) body = <Widget canManage={role === 'owner' || role === 'admin'} apiOrigin={me.api_origin} />;
  else body = <Invoices livemode={livemode} canWrite={role !== 'read_only'} canExport={role !== 'developer'} />;

  return (
    <div className={livemode ? 'app live' : 'app test'}>
      {!livemode && <div className="test-banner">Test mode: testnet data only, no real funds</div>}
      <header className="topbar">
        <strong className="brand">{me.merchant.name}</strong>
        <div className="mode" role="group" aria-label="Mode">
          <button className={livemode ? '' : 'on'} aria-pressed={!livemode} onClick={() => { switchMode(false); }}>Test</button>
          <button className={livemode ? 'on' : ''} aria-pressed={livemode} onClick={() => { switchMode(true); }}>Live</button>
        </div>
        <span className="muted">{me.user.email} · {role}</span>
        <button
          className="secondary"
          onClick={() => {
            void api('POST', '/auth/logout').finally(() => {
              setMe(null);
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
        <main>
          {!me.user.email_verified && <VerifyBanner />}
          {!totp && page !== 'security' && (
            <p className="notice">Protect your account: <a href="#/security">enable two-factor authentication</a>.</p>
          )}
          {/* key: switching mode remounts the page so no state from the other mode leaks into forms or lists */}
          <div key={String(livemode)}>{body}</div>
        </main>
      </div>
    </div>
  );
}
