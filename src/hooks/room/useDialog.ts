'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Open dialogs, oldest first. A glossary card opened inside the bid panel is the topmost: Escape and Tab belong to it alone. */
const open: HTMLElement[] = [];

/**
 * Focus handling for the room's dialogs: focus moves in on mount, Tab stays inside, Escape closes, and focus
 * returns to whatever opened the dialog. Only the topmost open dialog reacts to the keys. Attach the returned ref to the dialog element.
 */
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    open.push(el);
    const items = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !x.hasAttribute('disabled'));
    (items()[0] ?? el).focus();

    const onKey = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== el) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = open.lastIndexOf(el);
      if (at >= 0) open.splice(at, 1);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return ref;
}
