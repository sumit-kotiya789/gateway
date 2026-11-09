import { useEffect, useRef, useState } from 'react';
import { DASHBOARD, DEMO, PAGES, SIGNUP, href, type PageId } from '../router';
import { useScrollState } from './effects';
import { IArrow, IArrowUpRight, IMenu, IX, Logo } from './icons';

export function Header(props: { page: PageId }) {
  const progress = useRef<HTMLSpanElement>(null);
  const scrolled = useScrollState(progress);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [props.page]);
  useEffect(() => {
    document.documentElement.classList.toggle('lock', open);
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div className="progress" aria-hidden="true">
        <span ref={progress} />
      </div>
      <header className={`head ${scrolled || open ? 'scrolled' : ''}`}>
        <div className="head-bar">
          <a className="brand" href={href('home')} aria-label="Gateway home">
            <Logo id="logo-head" />
            Gateway
          </a>
          <nav className="nav" aria-label="Main">
            {PAGES.filter((p) => p.id !== 'home').map((p) => (
              <a key={p.id} href={href(p.id)} className={props.page === p.id ? 'on' : ''} aria-current={props.page === p.id ? 'page' : undefined}>
                {p.label}
              </a>
            ))}
          </nav>
          <div className="head-cta">
            <a className="btn ghost sm hide-sm" href={DASHBOARD}>Log in</a>
            <a className="btn primary sm" href={SIGNUP}>
              Start free <IArrow />
            </a>
            <button
              type="button"
              className="menu-btn"
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? <IX /> : <IMenu />}
            </button>
          </div>
        </div>
      </header>
      <div id="mobile-menu" className={`sheet ${open ? 'open' : ''}`} aria-hidden={!open}>
        {PAGES.map((p) => (
          <a key={p.id} className="nav-item" href={href(p.id)} tabIndex={open ? 0 : -1}>
            {p.label}
            <IArrow />
          </a>
        ))}
        <div className="sheet-cta">
          <a className="btn primary lg" href={SIGNUP} tabIndex={open ? 0 : -1}>Create a free account</a>
          <a className="btn ghost lg" href={DASHBOARD} tabIndex={open ? 0 : -1}>Log in</a>
        </div>
      </div>
    </>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="container">
        <div className="foot-grid">
          <div className="foot-brand">
            <a className="brand" href={href('home')}>
              <Logo id="logo-foot" />
              Gateway
            </a>
            <p>
              Crypto payment infrastructure for web3 products: a permanent deposit address per user, signed webhooks, payouts by API and a
              double-entry ledger behind every amount.
            </p>
            <div className="row">
              <span className="badge green">
                <span className="dot live" /> Test mode open
              </span>
              <span className="badge">BSC · USDT BEP-20</span>
            </div>
          </div>
          <div>
            <h4>Product</h4>
            <ul>
              <li><a href={href('home')}>Overview</a></li>
              <li><a href={href('how')}>How it works</a></li>
              <li><a href={href('security')}>Security</a></li>
              <li><a href={href('pricing')}>Pricing</a></li>
              <li><a href={DEMO}>Live demo</a></li>
            </ul>
          </div>
          <div>
            <h4>Developers</h4>
            <ul>
              <li><a href={href('docs', 'quickstart')}>Quickstart</a></li>
              <li><a href={href('api')}>API reference</a></li>
              <li><a href={href('api', 'webhooks')}>Webhooks</a></li>
              <li><a href={href('docs', 'sdk')}>Node.js SDK</a></li>
              <li><a href={href('api', 'errors')}>Errors</a></li>
            </ul>
          </div>
          <div>
            <h4>Account</h4>
            <ul>
              <li><a href={SIGNUP}>Create an account</a></li>
              <li><a href={DASHBOARD}>Log in</a></li>
              <li><a href={href('docs', 'test-mode')}>Test mode</a></li>
              <li><a href={href('docs', 'go-live')}>Go-live checklist</a></li>
              <li><a href={href('docs', 'woocommerce')}>WooCommerce <IArrowUpRight className="inline-ico" /></a></li>
            </ul>
          </div>
        </div>
      </div>
      <p className="foot-mark" aria-hidden="true">Gateway</p>
      <div className="container">
        <div className="foot-base">
          <span>© {new Date().getFullYear()} Gateway. Crypto payments on BNB Smart Chain.</span>
          <span>Test mode runs on BSC testnet with a test token: no real money moves.</span>
        </div>
      </div>
    </footer>
  );
}
