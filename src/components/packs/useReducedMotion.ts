'use client';

import { useEffect, useState } from 'react';

/** True when the visitor asked for less motion (prefers-reduced-motion). False on the server and until the first effect, so the markup is stable. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(q.matches);
    update();
    q.addEventListener?.('change', update);
    return () => q.removeEventListener?.('change', update);
  }, []);
  return reduced;
}
