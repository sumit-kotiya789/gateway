// Animated charts for the dashboard (D-110), plain SVG: no library, and no style attributes (CSP style-src 'self'):
// geometry goes in SVG attributes, colours and motion in styles.css (tone-* classes, chart-* keyframes).
import { useEffect, useId, useRef, useState, type MouseEvent, type TouchEvent } from 'react';
import { r1, r2 } from './format';

export type Tone = 'accent' | 'info' | 'danger' | 'warn' | 'muted' | 'violet';

/** Counts up to `value` (easeOutCubic). Restarts when the value changes. */
export function useCountUp(value: number, ms = 900): number {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - p) ** 3;
      setV(a + (value - a) * e);
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [value, ms]);
  return v;
}

export function CountUp(props: { value: number; format: (v: number) => string }) {
  return <>{props.format(useCountUp(props.value))}</>;
}

const nice = (max: number) => {
  if (max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  const n = max / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
};

/** Smooth path through points (Catmull-Rom as cubic Béziers), control points clamped to the plot. */
function smooth(pts: [number, number][], top: number, bottom: number): string {
  const [first] = pts;
  if (!first) return '';
  let d = `M${r1(first[0])},${r1(first[1])}`;
  const clamp = (y: number) => Math.max(top, Math.min(bottom, y));
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    if (!p0 || !p1 || !p2 || !p3) continue;
    const t = 0.18;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) * t);
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) * t);
    d += ` C${r1(c1x)},${r1(c1y)} ${r1(c2x)},${r1(c2y)} ${r1(p2[0])},${r1(p2[1])}`;
  }
  return d;
}

export interface Series {
  key: string;
  label: string;
  tone: Tone;
  values: number[];
  /** Draw only the line (no filled area). */
  line?: boolean;
}

/**
 * Area/line chart with a crosshair tooltip. `labels[i]` names point i (x axis and tooltip). Lines draw in, areas
 * fade up; hover or touch shows every series at that point.
 */
export function AreaChart(props: { labels: string[]; series: Series[]; height?: number; width?: number; format: (v: number) => string; empty?: string }) {
  const id = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Narrow panels pass a smaller width so labels stay readable once the SVG is scaled to fit.
  const W = props.width ?? 720;
  const H = props.height ?? 240;
  const pad = { l: 52, r: 14, t: 14, b: 28 };
  const n = props.labels.length;
  const max = nice(Math.max(0, ...props.series.flatMap((s) => s.values)));
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const step = Math.max(1, Math.ceil(n / 7));
  const allZero = props.series.every((s) => s.values.every((v) => v === 0));

  const pick = (clientX: number) => {
    const el = svgRef.current;
    if (!el || n === 0) return;
    const r = el.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((vx - pad.l) / (W - pad.l - pad.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const onMove = (e: MouseEvent<SVGRectElement>) => {
    pick(e.clientX);
  };
  const onTouch = (e: TouchEvent<SVGRectElement>) => {
    const t = e.touches[0];
    if (t) pick(t.clientX);
  };

  const tipW = 168;
  const tipH = 26 + props.series.length * 19;
  const hx = hover === null ? 0 : x(hover);
  const tipX = hx + 14 + tipW > W - pad.r ? hx - 14 - tipW : hx + 14;

  return (
    <div className="chart">
      <svg ref={svgRef} viewBox={`0 0 ${String(W)} ${String(H)}`} className="chart-svg" role="img" aria-label={props.series.map((s) => s.label).join(', ')}>
        <defs>
          {props.series.map((s) => (
            <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1" className={`tone-${s.tone}`}>
              <stop offset="0" stopColor="currentColor" stopOpacity="0.34" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className={i === 0 ? 'chart-axis' : 'chart-grid'} />
            <text x={pad.l - 10} y={y(v) + 4} className="chart-label" textAnchor="end">{props.format(v)}</text>
          </g>
        ))}
        {props.labels.map((l, i) =>
          (i % step === 0 && n - 1 - i >= step * 0.6) || i === n - 1 ? (
            <text key={i} x={x(i)} y={H - 8} className="chart-label" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{l}</text>
          ) : null,
        )}
        {props.series.map((s) => {
          const pts = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
          const line = smooth(pts, pad.t, H - pad.b);
          const area = pts.length > 0 ? `${line} L${r1(x(n - 1))},${String(H - pad.b)} L${r1(x(0))},${String(H - pad.b)} Z` : '';
          return (
            <g key={s.key} className={`tone-${s.tone}`}>
              {!s.line && <path d={area} fill={`url(#${id}-${s.key})`} className="chart-area" />}
              <path d={line} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="chart-line" />
            </g>
          );
        })}
        {allZero && props.empty && <text x={(W + pad.l) / 2} y={H / 2} className="chart-empty" textAnchor="middle">{props.empty}</text>}
        {hover !== null && (
          <g className="chart-hover">
            <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} className="chart-cross" />
            {props.series.map((s) => (
              <circle key={s.key} cx={hx} cy={y(s.values[hover] ?? 0)} r={4.5} className={`chart-dot tone-${s.tone}`} />
            ))}
            <g transform={`translate(${r1(tipX)},${String(pad.t + 4)})`}>
              <rect width={tipW} height={tipH} rx={10} className="chart-tip" />
              <text x={12} y={18} className="chart-tip-title">{props.labels[hover]}</text>
              {props.series.map((s, i) => (
                <g key={s.key} transform={`translate(12,${String(36 + i * 19)})`}>
                  <circle cx={4} cy={-4} r={4} className={`tone-${s.tone} chart-key`} />
                  <text x={14} y={0} className="chart-tip-label">{s.label}</text>
                  <text x={tipW - 24} y={0} className="chart-tip-value" textAnchor="end">{props.format(s.values[hover] ?? 0)}</text>
                </g>
              ))}
            </g>
          </g>
        )}
        <rect
          x={pad.l}
          y={pad.t}
          width={W - pad.l - pad.r}
          height={H - pad.t - pad.b}
          className="chart-catch"
          onMouseMove={onMove}
          onMouseLeave={() => { setHover(null); }}
          onTouchStart={onTouch}
          onTouchMove={onTouch}
          onTouchEnd={() => { setHover(null); }}
        />
      </svg>
    </div>
  );
}

/** Ring segments with a centre label. Segments sweep in. */
export function Donut(props: { parts: { label: string; value: number; tone: Tone }[]; center: string; sub: string }) {
  const total = props.parts.reduce((a, p) => a + p.value, 0);
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 42 42" className="donut-svg" aria-hidden="true">
        <circle cx="21" cy="21" r="15.915" className="donut-track" />
        {total > 0 &&
          props.parts.map((p) => {
            const pct = (p.value / total) * 100;
            const el = <circle key={p.label} cx="21" cy="21" r="15.915" pathLength={100} strokeDasharray={`${r2(pct)} ${r2(100 - pct)}`} strokeDashoffset={r2(25 - offset)} className={`donut-seg tone-${p.tone}`} />;
            offset += pct;
            return el;
          })}
      </svg>
      <div className="donut-center">
        <strong>{props.center}</strong>
        <span>{props.sub}</span>
      </div>
      <ul className="legend">
        {props.parts.map((p) => (
          <li key={p.label}>
            <span className={`legend-dot tone-${p.tone}`} aria-hidden="true" />
            <span className="legend-label">{p.label}</span>
            <span className="legend-value">{p.value}</span>
            <span className="legend-pct">{total > 0 ? `${Math.round((p.value / total) * 100)}%` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars that grow in, one per row, with a value at the end. */
export function Bars(props: { rows: { label: string; value: number; display: string; tone?: Tone; sub?: string }[] }) {
  const max = Math.max(1, ...props.rows.map((r) => r.value));
  return (
    <ul className="bars">
      {props.rows.map((r, i) => (
        <li key={r.label} className={`bar-row stagger-${String(Math.min(i, 9))}`}>
          <div className="bar-head">
            <span className="bar-label" title={r.label}>{r.label}</span>
            <span className="bar-value">{r.display}{r.sub && <small> {r.sub}</small>}</span>
          </div>
          <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="bar-svg" aria-hidden="true">
            <rect x="0" y="0" width="100" height="6" rx="3" className="bar-track" />
            <rect x="0" y="0" width={Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100)} height="6" rx="3" className={`bar-fill tone-${r.tone ?? 'accent'}`} />
          </svg>
        </li>
      ))}
    </ul>
  );
}

/** Tiny trend line for tables and cards. */
export function Sparkline(props: { values: number[]; tone?: Tone }) {
  const W = 96;
  const H = 28;
  const max = Math.max(1, ...props.values);
  const n = props.values.length;
  const pts = props.values.map((v, i) => [n <= 1 ? W / 2 : (i * W) / (n - 1), H - 3 - (v / max) * (H - 6)] as [number, number]);
  const d = smooth(pts, 2, H - 2);
  return (
    <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className={`spark tone-${props.tone ?? 'accent'}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" pathLength={1} className="chart-line" />
    </svg>
  );
}

/** A score ring (0-100) with the number inside. */
export function Ring(props: { value: number; tone: Tone; label: string }) {
  const v = useCountUp(props.value);
  return (
    <div className="ring">
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle cx="21" cy="21" r="15.915" className="donut-track" />
        <circle cx="21" cy="21" r="15.915" pathLength={100} strokeDasharray={`${String(props.value)} ${String(100 - props.value)}`} strokeDashoffset="25" className={`donut-seg tone-${props.tone}`} />
      </svg>
      <div className="ring-center">
        <strong>{Math.round(v)}</strong>
        <span>{props.label}</span>
      </div>
    </div>
  );
}
