import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../ui/effects';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** The hero's WebGL scene, loaded after first paint; a CSS orb stands in without WebGL. */
export function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'fallback'>('loading');
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!webglAvailable()) {
      setState('fallback');
      return;
    }
    let disposed = false;
    let scene: { dispose(): void } | undefined;
    import('./heroScene')
      .then((m) => {
        if (disposed) return;
        scene = m.createHeroScene(canvas, { reducedMotion: prefersReducedMotion() });
        setState('ready');
      })
      .catch(() => {
        if (!disposed) setState('fallback');
      });
    return () => {
      disposed = true;
      scene?.dispose();
    };
  }, []);
  return (
    <div className={`hero-visual ${state}`} aria-hidden="true">
      <canvas ref={ref} />
      <div className="hero-orb">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
