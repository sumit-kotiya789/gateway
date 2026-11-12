// One API key in depth (D-110): traffic over time, latency, status mix, busiest endpoints, and its digital
// fingerprint: every IP + client it was used from, with first/last seen, flagged against the allowlists. A client can
// go straight onto the account IP whitelist from here.
import { useState } from 'react';
import { api, totpHeader, type KeyAnalytics, type KeyClient, type WhitelistState } from './api';
import { AreaChart, Bars, CountUp, Donut, type Tone } from './charts';
import { ago, clientName, dayLabel, fmt1, fmtCompact, fmtPct, hourLabel } from './format';
import { Alert, CopyButton, EmptyState, ErrorBox, Field, Icon, Modal, Skeleton, Submit, TotpInput, fmtDate, toast, useAction, useLoad } from './ui';

const DAYS = [1, 7, 30, 90] as const;

function AddToWhitelist(props: { ip: string; canManage: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const a = useAction();
  if (!props.canManage) return null;
  return (
    <>
      <button type="button" className="secondary sm" onClick={() => { setOpen(true); }}><Icon name="plus" size={14} />Whitelist</button>
      {open && (
        <Modal title="Add to the IP whitelist" icon="shield" onClose={() => { setOpen(false); }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const s = await api<WhitelistState>('GET', '/security/whitelist/?livemode=false');
                await api('PUT', '/security/whitelist/ips', { entries: [...s.ips.entries, { cidr: props.ip, label: label.trim() }] }, totpHeader(code));
                setOpen(false);
                toast.success('Added to the IP whitelist', props.ip);
                props.onDone();
              });
            }}
          >
            <p><code>{props.ip}</code> joins the account IP whitelist. It only restricts keys while the whitelist is on (Settings → Whitelist IPs).</p>
            <Field label="Label"><input value={label} onChange={(e) => { setLabel(e.target.value); }} maxLength={60} placeholder="e.g. Production server" data-autofocus /></Field>
            <TotpInput value={code} onChange={setCode} />
            <ErrorBox error={a.error} />
            <div className="row end">
              <button type="button" className="secondary" onClick={() => { setOpen(false); }}>Cancel</button>
              <Submit busy={a.busy}>Add</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ClientRow(props: { c: KeyClient; canManage: boolean; onChange: () => void }) {
  const c = props.c;
  const who = clientName(c.user_agent);
  const flags: { text: string; tone: string }[] = [];
  if (c.new) flags.push({ text: 'new', tone: 's-pending' });
  if (c.blocked > 0) flags.push({ text: `${String(c.blocked)} blocked`, tone: 's-failed' });
  if (c.in_ip_whitelist === false) flags.push({ text: 'not whitelisted', tone: 's-low' });
  if (c.in_key_allowlist === false) flags.push({ text: 'outside key allowlist', tone: 's-low' });
  return (
    <tr>
      <td>
        <div className="fp-ip"><code>{c.ip}</code><CopyButton value={c.ip} /></div>
      </td>
      <td>
        <div className="fp-client">
          <span className={`fp-kind k-${who.kind}`}>{who.kind}</span>
          <span title={c.user_agent}>{who.name}</span>
        </div>
      </td>
      <td title={fmtDate(c.first_seen)}>{ago(c.first_seen)}</td>
      <td title={fmtDate(c.last_seen)}>{ago(c.last_seen)}<small className="muted fp-route">{c.last_route}</small></td>
      <td className="num">{fmtCompact(c.requests)}</td>
      <td className="num">{c.errors > 0 ? <span className="bad">{c.errors}</span> : 0}</td>
      <td>{flags.length > 0 ? flags.map((f) => <span key={f.text} className={`badge ${f.tone}`}>{f.text}</span>) : <span className="badge s-active">ok</span>}</td>
      <td>{c.in_ip_whitelist !== true && <AddToWhitelist ip={c.ip} canManage={props.canManage} onDone={props.onChange} />}</td>
    </tr>
  );
}

export function ApiKeyDetail(props: { id: string; canManage: boolean }) {
  const [days, setDays] = useState<number>(7);
  const r = useLoad(() => api<KeyAnalytics>('GET', `/api-keys/${props.id}/analytics?days=${String(days)}`), [props.id, days]);
  const back = <a className="back" href="#/api-keys"><Icon name="back" size={16} />API keys</a>;
  if (r.error) return <section>{back}<ErrorBox error={r.error} /></section>;
  if (!r.data) return <section>{back}<Skeleton /></section>;
  const a = r.data;
  const k = a.key;
  const label = (t: string) => (a.unit === 'hour' ? hourLabel(t) : dayLabel(t));
  const state = k.revoked_at ? 'revoked' : k.expires_at && Date.parse(k.expires_at) <= Date.now() ? 'expired' : 'active';
  const all: { label: string; value: number; tone: Tone }[] = [
    { label: '2xx success', value: a.statuses['2xx'] ?? 0, tone: 'accent' },
    { label: '3xx redirect', value: a.statuses['3xx'] ?? 0, tone: 'info' },
    { label: '4xx client error', value: a.statuses['4xx'] ?? 0, tone: 'warn' },
    { label: '5xx server error', value: a.statuses['5xx'] ?? 0, tone: 'danger' },
    { label: 'Blocked (IP)', value: a.statuses.blocked ?? 0, tone: 'violet' },
  ];
  const parts = all.filter((p) => p.value > 0 || p.label.startsWith('2'));
  const risky = a.clients.filter((c) => c.blocked > 0 || c.in_ip_whitelist === false || c.in_key_allowlist === false);
  const fresh = a.clients.filter((c) => c.new);

  return (
    <section className="key-detail">
      {back}
      <header className="hero-head">
        <div>
          <div className="eyebrow">{k.kind === 'secret' ? 'Secret key' : 'Publishable key'}</div>
          <h2>{k.name} <span className={`badge s-${state === 'active' ? 'active' : 'failed'}`}>{state}</span></h2>
          <p className="muted"><code>{k.prefix}…</code> · created {fmtDate(k.created_at)} · last used {ago(k.last_used_at)}</p>
        </div>
        <div className="hero-actions">
          <div className="mode" role="group" aria-label="Range">
            {DAYS.map((d) => (
              <button key={d} type="button" className={d === days ? 'on' : ''} aria-pressed={d === days} onClick={() => { setDays(d); }}>{d === 1 ? '24h' : `${String(d)}d`}</button>
            ))}
          </div>
        </div>
      </header>

      <div className="chip-row">
        {k.scopes.map((s) => <span key={s} className="scope-chip">{s}</span>)}
        {k.ip_allowlist ? <span className="scope-chip lock"><Icon name="lock" size={12} />key allowlist: {k.ip_allowlist.join(', ')}</span> : null}
        <span className={`scope-chip ${a.ip_whitelist_on ? 'lock' : 'open'}`}><Icon name="shield" size={12} />account IP whitelist {a.ip_whitelist_on ? 'on' : 'off'}</span>
      </div>

      {(risky.length > 0 || fresh.length > 0) && (
        <Alert tone={risky.length > 0 ? 'warning' : 'info'}>
          {risky.length > 0 ? `${String(risky.length)} client${risky.length === 1 ? '' : 's'} used this key from outside your allowlists or got blocked. ` : ''}
          {fresh.length > 0 ? `${String(fresh.length)} new client${fresh.length === 1 ? '' : 's'} in the last 24 hours. ` : ''}
          Check the fingerprint below; if one is not yours, revoke the key.
        </Alert>
      )}

      <div className="kpis">
        <div className="kpi tone-info"><div className="kpi-top"><span className="kpi-icon"><Icon name="activity" size={16} /></span><span className="kpi-label">Requests</span></div><div className="kpi-value"><CountUp value={a.totals.requests} format={(v) => fmtCompact(Math.round(v))} /></div><div className="kpi-foot"><span>{a.totals.blocked > 0 ? `+ ${String(a.totals.blocked)} blocked` : 'none blocked'}</span></div></div>
        <div className={`kpi tone-${a.totals.error_rate > 0.05 ? 'danger' : 'accent'}`}><div className="kpi-top"><span className="kpi-icon"><Icon name="success" size={16} /></span><span className="kpi-label">Success rate</span></div><div className="kpi-value"><CountUp value={a.totals.requests > 0 ? (1 - a.totals.error_rate) * 100 : 0} format={(v) => (a.totals.requests > 0 ? `${fmt1(v)}%` : '—')} /></div><div className="kpi-foot"><span>{a.totals.errors} errors</span></div></div>
        <div className="kpi tone-violet"><div className="kpi-top"><span className="kpi-icon"><Icon name="zap" size={16} /></span><span className="kpi-label">Avg latency</span></div><div className="kpi-value"><CountUp value={a.totals.avg_ms} format={(v) => String(Math.round(v))} /><small>ms</small></div><div className="kpi-foot"><span>server time per request</span></div></div>
        <div className="kpi tone-warn"><div className="kpi-top"><span className="kpi-icon"><Icon name="globe" size={16} /></span><span className="kpi-label">Fingerprint</span></div><div className="kpi-value"><CountUp value={a.totals.unique_ips} format={(v) => String(Math.round(v))} /><small>IPs</small></div><div className="kpi-foot"><span>{a.totals.clients} distinct clients</span></div></div>
      </div>

      <div className="grid-main">
        <div className="card panel chart-card">
          <header className="panel-head"><div><h3>Traffic</h3><span className="muted">requests per {a.unit}</span></div></header>
          <AreaChart
            key={`t-${String(days)}`}
            labels={a.series.map((p) => label(p.t))}
            height={250}
            format={fmtCompact}
            empty="No requests in this period"
            series={[
              { key: 'ok', label: 'Success', tone: 'accent', values: a.series.map((p) => p.ok) },
              { key: 'err', label: 'Errors', tone: 'danger', values: a.series.map((p) => p.errors), line: true },
              { key: 'blk', label: 'Blocked', tone: 'violet', values: a.series.map((p) => p.blocked), line: true },
            ]}
          />
        </div>
        <div className="card panel">
          <header className="panel-head"><h3>Responses</h3><span className="muted">{fmtPct(a.totals.error_rate)} errors</span></header>
          <Donut key={`d-${String(days)}`} parts={parts} center={fmtCompact(a.totals.requests + a.totals.blocked)} sub="requests" />
        </div>
      </div>

      <div className="grid-two">
        <div className="card panel">
          <header className="panel-head"><h3>Endpoints</h3><span className="muted">busiest first</span></header>
          {a.routes.length === 0 ? <p className="muted">No requests yet.</p> : (
            <Bars key={`r-${String(days)}`} rows={a.routes.map((x) => ({ label: x.route, value: x.requests, display: fmtCompact(x.requests), sub: `${String(x.avg_ms)} ms${x.errors > 0 ? ` · ${String(x.errors)} err` : ''}`, tone: x.errors > 0 ? 'warn' : 'info' }))} />
          )}
        </div>
        <div className="card panel">
          <header className="panel-head"><h3>Latency</h3><span className="muted">average per {a.unit}</span></header>
          <AreaChart key={`l-${String(days)}`} labels={a.series.map((p) => label(p.t))} width={460} height={220} format={(v) => `${String(Math.round(v))}ms`} empty="No requests in this period" series={[{ key: 'ms', label: 'Avg latency', tone: 'violet', values: a.series.map((p) => p.avg_ms) }]} />
        </div>
      </div>

      <div className="card panel">
        <header className="panel-head">
          <div><h3>Digital fingerprint</h3><span className="muted">every IP and client that used this key</span></div>
        </header>
        {a.clients.length === 0 ? (
          <EmptyState icon="globe" title="Not used yet">Requests made with this key show up here with their IP and client.</EmptyState>
        ) : (
          <div className="table-wrap flat">
            <table className="fp-table">
              <thead><tr><th>IP address</th><th>Client</th><th>First seen</th><th>Last seen</th><th className="num">Requests</th><th className="num">Errors</th><th>Flags</th><th /></tr></thead>
              <tbody>
                {a.clients.map((c) => <ClientRow key={`${c.ip}|${c.user_agent}`} c={c} canManage={props.canManage} onChange={r.reload} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
