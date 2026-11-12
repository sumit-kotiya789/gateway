// Dashboard home (D-110): payments at a glance for the selected mode. Animated KPIs with the change against the
// previous period, an interactive volume chart, status mix, payment funnel, API traffic and the security posture.
import { useState } from 'react';
import { api, type Me, type Overview as OverviewData } from './api';
import { Amount } from './asset';
import { AreaChart, Bars, CountUp, Donut, Ring, Sparkline, type Tone } from './charts';
import { ago, dayLabel, delta, fmt1, fmtAmount, fmtCompact, fmtPct } from './format';
import { ErrorBox, Icon, Skeleton, StatusBadge, useLoad, type IconName } from './ui';

const RANGE_KEY = 'gw_overview_days';
const RANGES = [7, 30, 90] as const;
type Metric = 'volume' | 'payments';

function storedRange(): number {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as readonly number[]).includes(v) ? v : 30;
  } catch {
    return 30;
  }
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const sum = (r: Record<string, string>) => Object.values(r).reduce((a, v) => a + Number(v), 0);
/** Whole numbers while counting up. */
const count = (v: number) => fmtCompact(Math.round(v));

function Kpi(props: { label: string; icon: IconName; value: number; format: (v: number) => string; unit?: string; change: { text: string; up: boolean } | null; spark?: number[]; tone?: Tone; foot?: string }) {
  return (
    <div className={`kpi tone-${props.tone ?? 'accent'}`}>
      <div className="kpi-top">
        <span className="kpi-icon"><Icon name={props.icon} size={16} /></span>
        <span className="kpi-label">{props.label}</span>
        {props.change && <span className={`kpi-delta ${props.change.up ? 'up' : 'down'}`}>{props.change.text}</span>}
      </div>
      <div className="kpi-value">
        <CountUp value={props.value} format={props.format} />
        {props.unit && <small>{props.unit}</small>}
      </div>
      <div className="kpi-foot">
        {props.spark && <Sparkline values={props.spark} tone={props.tone ?? 'accent'} />}
        {props.foot && <span>{props.foot}</span>}
      </div>
    </div>
  );
}

function Posture(props: { s: OverviewData['security']; livemode: boolean }) {
  const s = props.s;
  const items: { ok: boolean; weight: number; label: string; hint: string; href: string }[] = [
    { ok: s.totp, weight: 25, label: 'Two-factor authentication', hint: s.totp ? 'On for your account' : 'Turn it on: needed for keys, payouts and team changes', href: '#/settings/security' },
    { ok: s.team_members > 0 && s.team_with_2fa === s.team_members, weight: 15, label: 'Team 2FA', hint: `${String(s.team_with_2fa)} of ${String(s.team_members)} members`, href: '#/settings/team' },
    { ok: s.email_verified, weight: 10, label: 'Email verified', hint: s.email_verified ? 'Live mode unlocked' : 'Needed for live mode', href: '#/settings/security' },
    { ok: s.address_whitelist, weight: 20, label: 'Payout address whitelist', hint: s.address_whitelist ? 'On: payouts only to listed addresses' : 'Payouts can go to any address', href: '#/settings/whitelist-addresses' },
    { ok: s.ip_whitelist, weight: 20, label: 'API IP whitelist', hint: s.ip_whitelist ? 'Secret keys locked to your servers' : 'Secret keys work from any IP', href: '#/settings/whitelist-ips' },
    { ok: s.webhooks > 0, weight: 10, label: 'Webhooks', hint: s.webhooks > 0 ? `${String(s.webhooks)} endpoint${s.webhooks === 1 ? '' : 's'}` : 'Get told when invoices are paid', href: '#/webhooks' },
  ];
  const score = items.reduce((a, i) => a + (i.ok ? i.weight : 0), 0);
  return (
    <div className="card panel posture">
      <header className="panel-head">
        <h3>Security posture</h3>
        <a href="#/settings" className="panel-link">Settings <Icon name="external" size={13} /></a>
      </header>
      <div className="posture-body">
        <Ring value={score} tone={score >= 80 ? 'accent' : score >= 50 ? 'warn' : 'danger'} label="score" />
        <ul className="checklist-grid">
          {items.map((i) => (
            <li key={i.label}>
              <a href={i.href} className={i.ok ? 'ok' : 'todo'}>
                <span className="check-icon"><Icon name={i.ok ? 'check' : 'alert'} size={13} /></span>
                <span className="check-text"><strong>{i.label}</strong><small>{i.hint}</small></span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Overview(props: { livemode: boolean; me: Me }) {
  const [days, setDaysState] = useState(storedRange);
  const [metric, setMetric] = useState<Metric>('volume');
  const [token, setToken] = useState<string>();
  const r = useLoad(() => api<OverviewData>('GET', `/overview?livemode=${String(props.livemode)}&days=${String(days)}`), [props.livemode, days]);
  const setDays = (d: number) => {
    setDaysState(d);
    try {
      localStorage.setItem(RANGE_KEY, String(d));
    } catch {
      // storage unavailable: the range lasts for this page only
    }
  };

  const head = (
    <header className="hero-head">
      <div>
        <div className="eyebrow">{greeting()}</div>
        <h2>{props.me.merchant.name}</h2>
        <p className="muted">Your payments over the last {days} days.</p>
      </div>
      <div className="hero-actions">
        <a className="btn secondary sm" href="#/invoices"><Icon name="invoice" size={15} />Invoices</a>
        <a className="btn secondary sm" href="#/api-keys"><Icon name="key" size={15} />API keys</a>
        <div className="mode" role="group" aria-label="Range">
          {RANGES.map((d) => (
            <button key={d} type="button" className={d === days ? 'on' : ''} aria-pressed={d === days} onClick={() => { setDays(d); }}>{d}d</button>
          ))}
        </div>
      </div>
    </header>
  );

  if (r.error) return <section>{head}<ErrorBox error={r.error} /></section>;
  if (!r.data) return <section>{head}<div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="kpi skeleton-card" />)}</div><Skeleton /></section>;
  const o = r.data;

  const symbols = [...new Set([...Object.keys(o.current.volume), ...o.series.flatMap((d) => Object.keys(d.volume))])];
  const sym = token && symbols.includes(token) ? token : (symbols.sort((a, b) => Number(o.current.volume[b] ?? 0) - Number(o.current.volume[a] ?? 0))[0] ?? 'USDT');
  const vol = Number(o.current.volume[sym] ?? 0);
  const volPrev = Number(o.previous.volume[sym] ?? 0);
  const daily = o.series.map((d) => Number(d.volume[sym] ?? 0));
  const labels = o.series.map((d) => dayLabel(d.t));
  const avg = o.current.paid > 0 ? sum(o.current.volume) / o.current.paid : 0;
  const avgPrev = o.previous.paid > 0 ? sum(o.previous.volume) / o.previous.paid : 0;
  const st = o.statuses;
  const n = (...k: string[]) => k.reduce((a, s) => a + (st[s] ?? 0), 0);
  const parts: { label: string; value: number; tone: Tone }[] = [
    { label: 'Paid', value: n('paid', 'overpaid', 'settled'), tone: 'accent' },
    { label: 'In progress', value: n('created', 'pending', 'detected', 'confirming'), tone: 'info' },
    { label: 'Partial', value: n('underpaid', 'partially_paid'), tone: 'warn' },
    { label: 'Review', value: n('held', 'late_payment'), tone: 'violet' },
    { label: 'Expired', value: n('expired', 'cancelled', 'failed'), tone: 'muted' },
  ];
  const f = o.funnel;
  const pct = (v: number) => (f.created > 0 ? fmtPct(v / f.created, 0) : '—');
  const apiTotal = o.api.reduce((a, d) => a + d.requests, 0);
  const apiErr = o.api.reduce((a, d) => a + d.errors, 0);

  return (
    <section className="overview">
      {head}
      <div className="kpis">
        <Kpi label={`Volume · ${sym}`} icon="coins" value={vol} format={fmtCompact} change={delta(vol, volPrev)} spark={daily} foot={`vs ${fmtCompact(volPrev)} before`} />
        <Kpi label="Successful payments" icon="success" value={o.current.paid} format={(v) => String(Math.round(v))} change={delta(o.current.paid, o.previous.paid)} spark={o.series.map((d) => d.paid)} tone="info" foot={`${String(o.current.created)} invoices created`} />
        <Kpi label="Conversion" icon="trend" value={o.current.conversion * 100} format={(v) => `${fmt1(v)}%`} change={o.previous.created > 0 ? { text: `${o.current.conversion >= o.previous.conversion ? '+' : ''}${fmt1((o.current.conversion - o.previous.conversion) * 100)} pt`, up: o.current.conversion >= o.previous.conversion } : null} tone="violet" foot="paid of created" />
        <Kpi label="Average payment" icon="wallet" value={avg} format={fmtAmount} change={delta(avg, avgPrev)} tone="warn" foot={o.attention > 0 ? `${String(o.attention)} need attention` : `${String(o.open)} open now`} />
      </div>

      <div className="grid-main">
        <div className="card panel chart-card">
          <header className="panel-head">
            <div>
              <h3>{metric === 'volume' ? 'Payment volume' : 'Payments and invoices'}</h3>
              <span className="muted">{metric === 'volume' ? `${sym} received per day on every network, by invoice date` : 'Paid against created, per day'}</span>
            </div>
            <div className="row">
              {metric === 'volume' && symbols.length > 1 && (
                <div className="chips">
                  {symbols.map((s) => <button key={s} type="button" className={`chip-btn${s === sym ? ' on' : ''}`} onClick={() => { setToken(s); }}>{s}</button>)}
                </div>
              )}
              <div className="mode" role="group" aria-label="Metric">
                <button type="button" className={metric === 'volume' ? 'on' : ''} onClick={() => { setMetric('volume'); }}>Volume</button>
                <button type="button" className={metric === 'payments' ? 'on' : ''} onClick={() => { setMetric('payments'); }}>Payments</button>
              </div>
            </div>
          </header>
          <AreaChart
            key={`${metric}-${sym}-${String(days)}`}
            labels={labels}
            height={260}
            format={metric === 'volume' ? fmtCompact : (v) => String(Math.round(v))}
            empty="No payments in this period yet"
            series={
              metric === 'volume'
                ? [{ key: 'v', label: sym, tone: 'accent', values: daily }]
                : [
                    { key: 'p', label: 'Paid', tone: 'accent', values: o.series.map((d) => d.paid) },
                    { key: 'c', label: 'Created', tone: 'info', values: o.series.map((d) => d.created), line: true },
                  ]
            }
          />
        </div>
        <div className="card panel">
          <header className="panel-head"><h3>Invoice status</h3><span className="muted">last {days} days</span></header>
          <Donut key={String(days)} parts={parts} center={String(o.current.created)} sub="invoices" />
        </div>
      </div>

      <div className="grid-three">
        <div className="card panel">
          <header className="panel-head"><h3>Payment funnel</h3><span className="muted">{pct(f.paid)} reach paid</span></header>
          <Bars
            key={String(days)}
            rows={[
              { label: 'Invoices created', value: f.created, display: String(f.created), tone: 'info' },
              { label: 'Payment seen', value: f.seen, display: String(f.seen), sub: pct(f.seen), tone: 'violet' },
              { label: 'Paid', value: f.paid, display: String(f.paid), sub: pct(f.paid), tone: 'accent' },
              { label: 'Settled', value: f.settled, display: String(f.settled), sub: pct(f.settled), tone: 'accent' },
            ]}
          />
          <div className="insights">
            <div><span>Never paid</span><strong>{f.created - f.seen}</strong><small>{f.created > 0 ? fmtPct((f.created - f.seen) / f.created, 0) : '—'} of invoices</small></div>
            <div><span>Seen, not paid</span><strong>{f.seen - f.paid}</strong><small>underpaid, late or pending</small></div>
            <div><span>Waiting to settle</span><strong>{f.paid - f.settled}</strong><small>paid, not settled yet</small></div>
          </div>
        </div>
        <div className="card panel">
          <header className="panel-head">
            <h3>API traffic</h3>
            <a href="#/api-keys" className="panel-link">Keys <Icon name="external" size={13} /></a>
          </header>
          <div className="mini-stats">
            <div><strong><CountUp value={apiTotal} format={count} /></strong><span>requests</span></div>
            <div><strong className={apiErr > 0 ? 'bad' : ''}><CountUp value={apiErr} format={count} /></strong><span>errors</span></div>
            <div><strong>{apiTotal > 0 ? fmtPct(1 - apiErr / apiTotal) : '—'}</strong><span>success</span></div>
          </div>
          <AreaChart
            key={String(days)}
            labels={o.api.map((d) => dayLabel(d.t))}
            width={380}
            height={190}
            format={fmtCompact}
            empty="No API calls yet"
            series={[
              { key: 'r', label: 'Requests', tone: 'info', values: o.api.map((d) => d.requests) },
              { key: 'e', label: 'Errors', tone: 'danger', values: o.api.map((d) => d.errors), line: true },
            ]}
          />
        </div>
        <Posture s={o.security} livemode={props.livemode} />
      </div>

      <div className="card panel">
        <header className="panel-head">
          <h3>Recent invoices</h3>
          <a href="#/invoices" className="panel-link">All invoices <Icon name="external" size={13} /></a>
        </header>
        {o.recent.length === 0 ? (
          <p className="muted">No invoices yet. Create one with the API or a payment link.</p>
        ) : (
          <div className="table-wrap flat">
            <table>
              <thead><tr><th>Created</th><th>Order</th><th>Status</th><th className="num">Amount</th><th className="num">Received</th></tr></thead>
              <tbody>
                {o.recent.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => { location.hash = `#/invoices/${i.id}`; }}>
                    <td><a href={`#/invoices/${i.id}`}>{ago(i.created_at)}</a></td>
                    <td>{i.order_id ?? <span className="muted">—</span>}</td>
                    <td><StatusBadge status={i.status} /></td>
                    <td className="num"><Amount value={i.amount} token={i.token} symbol={i.symbol} /></td>
                    <td className="num"><Amount value={i.amount_received} token={i.token} symbol={i.symbol} tag={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
