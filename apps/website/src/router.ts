// Hash routing: #/<page>[/<section>]. Static hosting needs no server routes; sections are deep links inside a page.
import { useEffect, useState } from 'react';

export type PageId = 'home' | 'how' | 'security' | 'pricing' | 'docs' | 'api';
export interface Route { page: PageId; section: string | null }

export const PAGES: { id: PageId; label: string }[] = [
  { id: 'home', label: 'Product' },
  { id: 'how', label: 'How it works' },
  { id: 'security', label: 'Security' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'docs', label: 'Docs' },
  { id: 'api', label: 'API reference' },
];

export const DASHBOARD = (import.meta.env.VITE_DASHBOARD_URL as string | undefined) ?? 'http://localhost:8080';
export const DEMO = (import.meta.env.VITE_DEMO_URL as string | undefined) ?? 'http://localhost:8083';
export const SIGNUP = `${DASHBOARD}/#/signup`;

export function href(page: PageId, section?: string): string {
  return section ? `#/${page}/${section}` : `#/${page}`;
}

export function parseRoute(hash: string): Route {
  const [p, s] = hash.replace(/^#\/?/, '').split('/');
  const page = PAGES.find((x) => x.id === p)?.id ?? 'home';
  return { page, section: s ? decodeURIComponent(s) : null };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('hashchange', on);
    };
  }, []);
  return route;
}

/** Scroll a section into view below the fixed header. */
export function scrollToId(id: string, smooth = true): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
  return true;
}
