import { useEffect, useLayoutEffect, useRef } from 'react';
import { Api } from './pages/Api';
import { Docs } from './pages/Docs';
import { Home } from './pages/Home';
import { How } from './pages/How';
import { Pricing } from './pages/Pricing';
import { Security } from './pages/Security';
import { scrollToId, useRoute, type PageId } from './router';
import { Footer, Header } from './ui/Chrome';
import { usePointerEffects, useReveal } from './ui/effects';

const TITLES: Record<PageId, string> = {
  home: 'Gateway — crypto deposits and payouts for web3 apps',
  how: 'How it works — Gateway',
  security: 'Security — Gateway',
  pricing: 'Pricing — Gateway',
  docs: 'Docs — Gateway',
  api: 'API reference — Gateway',
};

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
    if (route.section) {
      const id = route.section;
      requestAnimationFrame(() => {
        if (!scrollToId(id, samePage)) window.scrollTo(0, 0);
      });
    } else if (!samePage) window.scrollTo(0, 0);
  }, [route.page, route.section]);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
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
        {route.page === 'home' && <Home />}
        {route.page === 'how' && <How />}
        {route.page === 'security' && <Security />}
        {route.page === 'pricing' && <Pricing />}
        {route.page === 'docs' && <Docs />}
        {route.page === 'api' && <Api />}
      </main>
      <Footer />
    </div>
  );
}
