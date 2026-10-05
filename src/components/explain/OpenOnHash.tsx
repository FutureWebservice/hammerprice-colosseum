'use client';

/**
 * Client only for the hash handling: a link to any id inside a folded <details> (a FAQ group, for example) opens the fold
 * first, because not every browser expands a closed <details> on a fragment jump.
 */
import { useEffect } from 'react';

export default function OpenOnHash() {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      let changed = false;
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (n instanceof HTMLDetailsElement && !n.open) { n.open = true; changed = true; }
      }
      if (changed) el.scrollIntoView();
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  return null;
}
