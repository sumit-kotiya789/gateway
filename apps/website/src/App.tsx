import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { Home } from './pages/Home';
import { scrollToId, useRoute, type PageId } from './router';
import { Footer, Header } from './ui/Chrome';
import { usePointerEffects, useReveal } from './ui/effects';

// The landing page ships in the main bundle; the others (the API reference and its data, the guides) are separate
// chunks, fetched in the background once the browser is idle so navigation stays instant.
const loaders = {
  how: () => import('./pages/How').then((m) => ({ default: m.How })),
  security: () => import('./pages/Security').then((m) => ({ default: m.Security })),
  pricing: () => import('./pages/Pricing').then((m) => ({ default: m.Pricing })),
  docs: () => import('./pages/Docs').then((m) => ({ default: m.Docs })),
  api: () => import('./pages/Api').then((m) => ({ default: m.Api })),
};
const How = lazy(loaders.how);
const Security = lazy(loaders.security);
const Pricing = lazy(loaders.pricing);
const Docs = lazy(loaders.docs);
const Api = lazy(loaders.api);

const TITLES: Record<PageId, string> = {
  home: 'Gateway — crypto deposits and payouts for web3 apps',
  how: 'How it works — Gateway',
  security: 'Security — Gateway',
  pricing: 'Pricing — Gateway',
  docs: 'Docs — Gateway',
  api: 'API reference — Gateway',
};

/** Scrolls to a section once it exists (a lazy page may still be loading); gives up after ~2 s. */
function scrollWhenReady(id: string, smooth: boolean): () => void {
  let raf = 0;
  let tries = 0;
  const tick = () => {
    if (scrollToId(id, smooth)) return;
    if (++tries < 120) raf = requestAnimationFrame(tick);
    else window.scrollTo(0, 0);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
  };
}

export function App() {
  const route = useRoute();
  const prevPage = useRef<PageId | null>(null);
  useReveal(route.page);
  usePointerEffects();

  // New page: jump to its top (or the deep-linked section). Same page: glide to the section.
  useLayoutEffect(() => {
    const samePage = prevPage.current === route.page;
    prevPage.current = route.page;
    document.title = TITLES[route.page];
    if (route.section) return scrollWhenReady(route.section, samePage);
    if (!samePage) window.scrollTo(0, 0);
    return undefined;
  }, [route.page, route.section]);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const prefetch = () => {
      for (const load of Object.values(loaders)) void load();
    };
    const ric = (window as Partial<Window>).requestIdleCallback?.bind(window);
    if (ric) ric(prefetch, { timeout: 4000 });
    else window.setTimeout(prefetch, 2000);
  }, []);

  return (
    <div className="site">
      <a className="skip" href="#main" onClick={(e) => {
        e.preventDefault();
        document.getElementById('main')?.focus();
      }}>
        Skip to content
      </a>
      <Header page={route.page} />
      <main id="main" tabIndex={-1} key={route.page} className="page-enter">
        <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
          {route.page === 'home' && <Home />}
          {route.page === 'how' && <How />}
          {route.page === 'security' && <Security />}
          {route.page === 'pricing' && <Pricing />}
          {route.page === 'docs' && <Docs />}
          {route.page === 'api' && <Api />}
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
