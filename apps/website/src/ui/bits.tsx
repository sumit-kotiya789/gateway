import { useState, type ReactNode } from 'react';
import { IAlert, IChevron, IInfo, IShield } from './icons';
import { NETWORKS, logoUri } from '@gw/networks';

/** Inline formatting for content strings: `code`, **bold**, [label](href). */
export function Rich(props: { text: string }) {
  const parts: ReactNode[] = [];
  const rx = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let n = 0;
  for (const m of props.text.matchAll(rx)) {
    if (m.index > last) parts.push(props.text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<code key={n++}>{m[1]}</code>);
    else if (m[2] !== undefined) parts.push(<strong key={n++}>{m[2]}</strong>);
    else if (m[3] !== undefined && m[4] !== undefined) parts.push(<a key={n++} href={m[4]}>{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < props.text.length) parts.push(props.text.slice(last));
  return <>{parts}</>;
}

export function SectionHead(props: { eyebrow: string; title: ReactNode; lead?: ReactNode; center?: boolean; id?: string }) {
  return (
    <div className={`section-head reveal ${props.center ? 'center' : ''}`} id={props.id}>
      <span className="eyebrow">{props.eyebrow}</span>
      <h2>{props.title}</h2>
      {props.lead !== undefined && <p className="lead">{props.lead}</p>}
    </div>
  );
}

export function Callout(props: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const kind = props.kind ?? 'info';
  const icon = kind === 'ok' ? <IShield /> : kind === 'info' ? <IInfo /> : <IAlert />;
  return (
    <div className={`callout ${kind === 'ok' ? '' : kind}`}>
      {icon}
      <div>{props.children}</div>
    </div>
  );
}

/** Mainnets where USDT is accepted (D-112), in the order shown. */
export const LIVE_NETWORKS = ['bsc', 'eth', 'polygon'] as const;

/** The supported networks by official logo and name: "[logo] BNB Smart Chain [logo] Ethereum [logo] Polygon PoS". */
export function Networks(props: { names?: boolean; className?: string }) {
  return (
    <span className={`networks${props.className ? ` ${props.className}` : ''}`}>
      {LIVE_NETWORKS.map((id) => {
        const n = NETWORKS[id];
        return n ? (
          <span key={id} className="network" title={`USDT on ${n.name} (${n.tag})`}>
            <img src={logoUri(n.logo)} alt={props.names === false ? n.name : ''} width={16} height={16} />
            {props.names !== false && <span>{n.name}</span>}
          </span>
        ) : null;
      })}
    </span>
  );
}

/** The USDT mark (official Tether logo). */
export function UsdtMark() {
  return <img className="usdt-mark" src={logoUri('USDT')} alt="" width={16} height={16} />;
}

export interface Qa { q: string; a: string }

export function Faq(props: { items: Qa[] }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq">
      {props.items.map((it, i) => {
        const on = open === i;
        return (
          <div key={it.q} className="faq-item reveal" data-open={on}>
            <button
              type="button"
              className="faq-q"
              aria-expanded={on}
              onClick={() => {
                setOpen(on ? null : i);
              }}
            >
              <span>{it.q}</span>
              <IChevron />
            </button>
            <div className="faq-a" role="region" aria-hidden={!on}>
              <div>
                <p>
                  <Rich text={it.a} />
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const METHOD_CLASS: Record<string, string> = { GET: 'green', POST: 'blue', PATCH: 'amber', PUT: 'amber', DELETE: 'red' };
export function Method(props: { m: string; small?: boolean }) {
  return <span className={`method ${METHOD_CLASS[props.m] ?? ''} ${props.small ? 'sm' : ''}`}>{props.m}</span>;
}

/** Decorative pseudo-QR (not scannable): a deterministic grid from a seed string. */
export function PseudoQr(props: { seed: string; size?: number }) {
  const n = 21;
  let h = 2166136261;
  for (const ch of props.seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rnd = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  const cells: ReactNode[] = [];
  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (finder(x, y)) continue;
      if (rnd() > 0.52) cells.push(<rect key={`${String(x)}-${String(y)}`} x={x} y={y} width="1" height="1" rx="0.2" />);
    }
  }
  const eye = (x: number, y: number) => (
    <g key={`e${String(x)}${String(y)}`}>
      <rect x={x + 0.5} y={y + 0.5} width="6" height="6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x={x + 2} y={y + 2} width="3" height="3" rx="0.8" />
    </g>
  );
  return (
    <svg viewBox={`-1 -1 ${String(n + 2)} ${String(n + 2)}`} className="qr" aria-hidden="true" fill="currentColor">
      {cells}
      {eye(0, 0)}
      {eye(n - 7, 0)}
      {eye(0, n - 7)}
    </svg>
  );
}
