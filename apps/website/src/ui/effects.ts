// Site-wide motion: scroll reveal, pointer spotlight and 3D tilt, count-up numbers, scroll progress, scroll spy.
// Runtime values go through the CSSOM (style.setProperty), which CSP style-src 'self' allows.
import { useEffect, useRef, useState, type RefObject } from 'react';

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Adds `.in` to every `.reveal` element as it scrolls into view, including elements added later. */
export function useReveal(key: string) {
  useEffect(() => {
    const reduced = prefersReducedMotion();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -6% 0px' },
    );
    const scan = (root: ParentNode) => {
      root.querySelectorAll('.reveal:not(.in)').forEach((el) => {
        if (reduced) el.classList.add('in');
        else io.observe(el);
      });
    };
    scan(document);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n instanceof Element) {
            if (n.matches('.reveal:not(.in)')) {
              if (reduced) n.classList.add('in');
              else io.observe(n);
            }
            scan(n);
          }
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [key]);
}

/** One delegated pointer handler: `.spot` gets --mx/--my, `.tilt` gets --rx/--ry (fine pointers only). */
export function usePointerEffects() {
  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!fine) return;
    const reduced = prefersReducedMotion();
    let tiltEl: HTMLElement | null = null;
    const resetTilt = () => {
      if (!tiltEl) return;
      tiltEl.classList.remove('tilting');
      tiltEl.style.setProperty('--rx', '0deg');
      tiltEl.style.setProperty('--ry', '0deg');
      tiltEl = null;
    };
    // Mice report up to 1000 moves/s: keep the latest and apply it once per frame.
    let pending: PointerEvent | null = null;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      pending = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const apply = () => {
      raf = 0;
      const e = pending;
      pending = null;
      if (!e) return;
      const target = e.target instanceof Element ? e.target : null;
      const spot = target?.closest<HTMLElement>('.spot');
      if (spot) {
        const r = spot.getBoundingClientRect();
        spot.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
        spot.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
      }
      if (reduced) return;
      const tilt = target?.closest<HTMLElement>('.tilt') ?? null;
      if (tilt !== tiltEl) resetTilt();
      if (tilt) {
        tiltEl = tilt;
        const r = tilt.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        const max = Number(tilt.dataset.tilt ?? '8');
        tilt.classList.add('tilting');
        tilt.style.setProperty('--rx', `${Math.round(-py * max * 100) / 100}deg`);
        tilt.style.setProperty('--ry', `${Math.round(px * max * 100) / 100}deg`);
      }
    };
    const onLeave = () => {
      resetTilt();
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

/** Header state + top progress bar. */
export function useScrollState(progressRef: RefObject<HTMLSpanElement | null>) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const y = window.scrollY;
      setScrolled(y > 12);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progressRef.current?.style.setProperty('--p', String(max > 0 ? Math.min(1, y / max) : 0));
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [progressRef]);
  return scrolled;
}

/** Fires once when the element first becomes visible. */
export function useInView<T extends Element>(threshold = 0.3): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [seen, threshold]);
  return [ref, seen];
}

/** True while the element is on screen (unlike useInView, which latches): pauses offscreen loops. */
export function useVisible<T extends Element>(threshold = 0.15): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        const e = es[es.length - 1];
        if (e) setVisible(e.isIntersecting);
      },
      { threshold },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [threshold]);
  return [ref, visible];
}

/** Counts a stat tile's number up once, writing the text node directly (no React render per frame). */
export function useCountUpText(ref: RefObject<HTMLElement | null>, to: number, run: boolean, ms = 1600) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !run) return;
    if (prefersReducedMotion()) {
      el.textContent = String(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 4))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [ref, to, run, ms]);
}

/** Highlights the section currently under the header; ids in document order. */
export function useScrollSpy(ids: readonly string[], offset = 140): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    let raf = 0;
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null);
    const update = () => {
      raf = 0;
      let current: string | null = els[0]?.id ?? null;
      for (const el of els) {
        if (el.getBoundingClientRect().top - offset <= 0) current = el.id;
        else break;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = els[els.length - 1]?.id ?? current;
      setActive(current);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ids, offset]);
  return active;
}

/** A value that cycles 0..n-1 every `ms` while `run` is true (pipelines, feeds). */
export function useTicker(n: number, ms: number, run = true): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!run || prefersReducedMotion()) return;
    const t = window.setInterval(() => {
      setI((x) => (x + 1) % n);
    }, ms);
    return () => {
      window.clearInterval(t);
    };
  }, [n, ms, run]);
  return i;
}
