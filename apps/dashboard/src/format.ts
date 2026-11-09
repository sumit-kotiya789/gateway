// Number, date and client formatting shared by the dashboard pages.

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** 1234 -> "1.2K". */
export const fmtCompact = (v: number) => (Math.abs(v) < 1000 ? money.format(Math.round(v * 100) / 100) : compact.format(v));
/** Token amount for display (2 decimals max). Display only: amounts stay strings everywhere else. */
export const fmtAmount = (v: number) => money.format(v);
const pctFmt = [0, 1].map((d) => new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d }));
const oneFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtPct = (v: number, digits: 0 | 1 = 1) => (pctFmt[digits] ?? oneFmt).format(v);
/** One decimal, for display ("12.5"). */
export const fmt1 = (v: number) => oneFmt.format(v);
/** SVG coordinates: rounded numbers as attribute strings (no float formatting helpers: lint bans them for money). */
export const r1 = (v: number) => String(Math.round(v * 10) / 10);
export const r2 = (v: number) => String(Math.round(v * 100) / 100);

/** Change against the previous period: "+12.5%", or null when there is nothing to compare with. */
export function delta(now: number, before: number): { text: string; up: boolean } | null {
  if (before === 0) return now === 0 ? null : { text: 'new', up: true };
  const d = (now - before) / before;
  return { text: `${d >= 0 ? '+' : ''}${fmtPct(d)}`, up: d >= 0 };
}

export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${String(Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))} h ago`;
  return `${String(Math.floor(s / 86_400))} d ago`;
}

/** A readable name for an HTTP client from its user agent: what the key's fingerprint table shows. */
export function clientName(ua: string): { name: string; kind: 'server' | 'browser' | 'tool' | 'unknown' } {
  if (!ua) return { name: 'No user agent', kind: 'unknown' };
  const m = (re: RegExp) => re.exec(ua);
  const ver = (r: RegExpExecArray | null) => (r?.[1] ? ` ${r[1]}` : '');
  const rules: [RegExp, string, 'server' | 'browser' | 'tool'][] = [
    [/curl\/([\d.]+)/i, 'curl', 'tool'],
    [/PostmanRuntime\/([\d.]+)/i, 'Postman', 'tool'],
    [/insomnia\/([\d.]+)/i, 'Insomnia', 'tool'],
    [/python-requests\/([\d.]+)/i, 'Python requests', 'server'],
    [/aiohttp\/([\d.]+)/i, 'Python aiohttp', 'server'],
    [/httpx\/([\d.]+)/i, 'Python httpx', 'server'],
    [/node-fetch\/?([\d.]*)/i, 'Node.js node-fetch', 'server'],
    [/axios\/([\d.]+)/i, 'Node.js axios', 'server'],
    [/undici/i, 'Node.js fetch', 'server'],
    [/^node$/i, 'Node.js fetch', 'server'],
    [/gateway-sdk\/([\d.]+)/i, 'Gateway SDK', 'server'],
    [/Go-http-client\/([\d.]+)/i, 'Go net/http', 'server'],
    [/okhttp\/([\d.]+)/i, 'OkHttp', 'server'],
    [/Java\/([\d.]+)/i, 'Java', 'server'],
    [/GuzzleHttp\/([\d.]+)/i, 'PHP Guzzle', 'server'],
    [/Ruby/i, 'Ruby', 'server'],
    [/Edg\/([\d]+)/, 'Edge', 'browser'],
    [/Chrome\/([\d]+)/, 'Chrome', 'browser'],
    [/Firefox\/([\d]+)/, 'Firefox', 'browser'],
    [/Version\/([\d.]+).*Safari/, 'Safari', 'browser'],
  ];
  for (const [re, name, kind] of rules) {
    const r = m(re);
    if (r) {
      const os = kind === 'browser' ? (/Mac OS X/.test(ua) ? ' · macOS' : /Windows/.test(ua) ? ' · Windows' : /Android/.test(ua) ? ' · Android' : /iPhone|iPad/.test(ua) ? ' · iOS' : /Linux/.test(ua) ? ' · Linux' : '') : '';
      return { name: `${name}${ver(r)}${os}`, kind };
    }
  }
  return { name: ua.length > 40 ? `${ua.slice(0, 40)}…` : ua, kind: 'unknown' };
}
