// One place for every account setting (D-110): a section list on the left, the section on the right. Sections reuse
// the existing pages (security, team, payout wallet, widget) plus the whitelists (D-109).
import type { ReactNode } from 'react';
import { api, type Me, type WhitelistState } from './api';
import { NetworkSettings } from './network';
import { PayoutWallet } from './payout-wallet';
import { Security } from './settings';
import { Team } from './team';
import { CopyField, Icon, useLoad, type IconName } from './ui';
import { WhitelistAddresses, WhitelistIps } from './whitelist';
import { Widget } from './widget';

interface Section {
  id: string;
  label: string;
  icon: IconName;
  group: 'Account' | 'Funds security' | 'Developers';
  desc: string;
  show: boolean;
  href?: string;
}

export function SettingsHub(props: { section: string | undefined; me: Me; livemode: boolean; onChange: () => void }) {
  const role = props.me.user.role;
  const owner = role === 'owner';
  const dev = role === 'owner' || role === 'admin' || role === 'developer';
  const totp = props.me.user.totp_enabled;
  const wl = useLoad(() => api<WhitelistState>('GET', `/security/whitelist/?livemode=${String(props.livemode)}`), [props.livemode]);
  const sections: Section[] = [
    { id: 'general', label: 'General', icon: 'store', group: 'Account', desc: 'Your account at a glance', show: true },
    { id: 'security', label: 'Security', icon: 'lock', group: 'Account', desc: 'Two-factor authentication and recovery codes', show: true },
    { id: 'team', label: 'Team', icon: 'users', group: 'Account', desc: 'Members, roles and invitations', show: true },
    { id: 'network', label: 'Network', icon: 'coins', group: 'Account', desc: 'The chain your customers pay on', show: true },
    { id: 'whitelist-addresses', label: 'Whitelist addresses', icon: 'wallet', group: 'Funds security', desc: 'Where payouts may go', show: true },
    { id: 'whitelist-ips', label: 'Whitelist IPs', icon: 'globe', group: 'Funds security', desc: 'Where your secret keys work from', show: true },
    { id: 'payout-wallet', label: 'Payout wallet', icon: 'coins', group: 'Funds security', desc: 'How you receive payments', show: true },
    { id: 'widget', label: 'Checkout widget', icon: 'widget', group: 'Developers', desc: 'Sites allowed to embed the checkout', show: dev },
    { id: 'api-keys', label: 'API keys', icon: 'key', group: 'Developers', desc: 'Keys, traffic and fingerprints', show: dev, href: '#/api-keys' },
    { id: 'webhooks', label: 'Webhooks', icon: 'zap', group: 'Developers', desc: 'Event delivery to your server', show: dev, href: '#/webhooks' },
  ];
  const visible = sections.filter((s) => s.show);
  const current = visible.find((s) => s.id === props.section && !s.href) ?? visible[0];
  const w = wl.data;
  const badge = (id: string): ReactNode => {
    if (!w) return null;
    if (id === 'whitelist-addresses') return <span className={`dot-badge ${w.addresses.enabled ? 'on' : 'off'}`}>{w.addresses.enabled ? 'on' : 'off'}</span>;
    if (id === 'whitelist-ips') return <span className={`dot-badge ${w.ips.enabled ? 'on' : 'off'}`}>{w.ips.enabled ? 'on' : 'off'}</span>;
    if (id === 'security') return <span className={`dot-badge ${totp ? 'on' : 'warn'}`}>{totp ? '2FA' : 'set up'}</span>;
    return null;
  };

  let body: ReactNode;
  switch (current?.id) {
    case 'security':
      body = <Security totp={totp} onChange={props.onChange} />;
      break;
    case 'team':
      body = <Team me={props.me.user} totp={totp} />;
      break;
    case 'network':
      body = <NetworkSettings canManage={owner || role === 'admin'} totp={totp} onChange={props.onChange} />;
      break;
    case 'whitelist-addresses':
      body = <WhitelistAddresses livemode={props.livemode} canManage={owner} totp={totp} />;
      break;
    case 'whitelist-ips':
      body = <WhitelistIps livemode={props.livemode} canManage={owner} totp={totp} />;
      break;
    case 'payout-wallet':
      body = <PayoutWallet livemode={props.livemode} canManage={owner} totp={totp} onModeChange={props.onChange} />;
      break;
    case 'widget':
      body = <Widget canManage={owner || role === 'admin'} apiOrigin={props.me.api_origin} />;
      break;
    default:
      body = (
        <section>
          <header className="page-head"><h2>Settings</h2></header>
          <p className="lede-sm">Everything about your account in one place. Changes that move money or loosen security need the owner and a fresh 2FA code.</p>
          <div className="card">
            <dl className="details">
              <dt>Business</dt><dd>{props.me.merchant.name}</dd>
              <dt>Merchant id</dt><dd><CopyField value={props.me.merchant.id} /></dd>
              <dt>Your role</dt><dd className="cap">{role.replace('_', ' ')}</dd>
              <dt>Signed in as</dt><dd>{props.me.user.email}</dd>
              <dt>Receiving mode</dt><dd>{props.me.merchant.custody_mode.replace(/_/g, ' ')}</dd>
            </dl>
          </div>
          <div className="settings-tiles">
            {visible.filter((s) => s.id !== 'general').map((s) => (
              <a key={s.id} className="settings-tile" href={s.href ?? `#/settings/${s.id}`}>
                <span className="tile-icon"><Icon name={s.icon} size={18} /></span>
                <span className="tile-text"><strong>{s.label} {badge(s.id)}</strong><small>{s.desc}</small></span>
                <Icon name="external" size={14} className="tile-go" />
              </a>
            ))}
          </div>
        </section>
      );
  }

  return (
    <div className="settings-hub">
      <aside className="settings-nav-side" aria-label="Settings sections">
        {(['Account', 'Funds security', 'Developers'] as const).map((g) => {
          const items = visible.filter((s) => s.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g} className="sn-group">
              <div className="sn-label">{g}</div>
              {items.map((s) => (
                <a key={s.id} href={s.href ?? `#/settings/${s.id}`} className={current?.id === s.id ? 'active' : ''} aria-current={current?.id === s.id ? 'page' : undefined}>
                  <Icon name={s.icon} size={16} />
                  <span>{s.label}</span>
                  {badge(s.id)}
                </a>
              ))}
            </div>
          );
        })}
      </aside>
      <div className="settings-body">{body}</div>
    </div>
  );
}
