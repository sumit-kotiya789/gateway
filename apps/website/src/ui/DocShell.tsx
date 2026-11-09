import { useEffect, useRef, useState, type ReactNode } from 'react';
import { href, scrollToId, type PageId } from '../router';
import { useScrollSpy } from './effects';
import { IChevron, ISearch, IX } from './icons';
import { Method } from './bits';

/** Sidebar items: [id, label] or [id, label, HTTP method]. */
export interface NavGroup { title: string; items: ([string, string] | [string, string, string])[] }

export function DocShell(props: { page: PageId; nav: NavGroup[]; ids: readonly string[]; title: string; subtitle: string; search?: boolean; children: ReactNode; wide?: boolean }) {
  const active = useScrollSpy(props.ids);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  // Keep the URL on the section being read (no history entries, no hashchange).
  useEffect(() => {
    if (!active) return;
    const next = href(props.page, active);
    if (window.location.hash !== next) history.replaceState(null, '', next);
    const link = navRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(active)}"]`);
    const box = navRef.current;
    if (link && box) {
      const lr = link.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (lr.top < br.top + 40 || lr.bottom > br.bottom - 40) box.scrollTop += lr.top - br.top - br.height / 2;
    }
  }, [active, props.page]);

  const needle = q.trim().toLowerCase();
  const groups = props.nav
    .map((g) => ({ ...g, items: g.items.filter((it) => !needle || it[1].toLowerCase().includes(needle) || it[0].includes(needle) || (it[2] ?? '').toLowerCase() === needle) }))
    .filter((g) => g.items.length > 0);
  const activeLabel = props.nav.flatMap((g) => g.items).find((it) => it[0] === active)?.[1] ?? props.subtitle;

  return (
    <div className={`docs ${props.wide ? 'wide' : ''}`}>
      <button
        type="button"
        className="docs-toggle"
        aria-expanded={open}
        aria-controls="docs-nav"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="mono faint">{props.title}</span>
        <span className="dt-cur">{activeLabel}</span>
        <IChevron />
      </button>
      <aside className={`docs-side ${open ? 'open' : ''}`}>
        <div className="docs-side-head">
          <span className="eyebrow">{props.title}</span>
          <button
            type="button"
            className="docs-close"
            aria-label="Close navigation"
            onClick={() => {
              setOpen(false);
            }}
          >
            <IX />
          </button>
        </div>
        {props.search && (
          <label className="docs-search">
            <ISearch />
            <input
              type="search"
              placeholder="Filter endpoints…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
              }}
              aria-label="Filter the navigation"
            />
          </label>
        )}
        <nav id="docs-nav" ref={navRef} className="docs-nav" aria-label={`${props.title} sections`}>
          {groups.map((g) => (
            <div key={g.title} className="docs-group">
              <h4>{g.title}</h4>
              {g.items.map(([id, label, m]) => (
                <a
                  key={id}
                  data-id={id}
                  href={href(props.page, id)}
                  className={active === id ? 'on' : ''}
                  aria-current={active === id ? 'location' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    scrollToId(id);
                    history.replaceState(null, '', href(props.page, id));
                  }}
                >
                  {m && <Method m={m} small />}
                  <span>{label}</span>
                </a>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="faint small docs-empty">Nothing matches “{q}”.</p>}
        </nav>
      </aside>
      {open && (
        <div
          className="docs-scrim"
          aria-hidden="true"
          onClick={() => {
            setOpen(false);
          }}
        />
      )}
      <div className="docs-main">{props.children}</div>
    </div>
  );
}
