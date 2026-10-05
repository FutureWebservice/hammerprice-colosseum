'use client';

/**
 * The room's two sidebars, shared by the chat (left) and the AI assistant (right): what the CSS cannot do.
 *  - Below 1280 px only one fits next to the room, so opening one closes the other (the opener keeps the focus).
 *  - Escape closes the sidebar the focus is in (or the only open one); a dialog on top of it (the report dialog) takes the key first.
 *  - On a phone (max 980 px) a sidebar is a full screen sheet: Tab stays inside it. On a desktop it is a side panel, not a trap.
 *  - Closing returns the focus to the sidebar's launcher, unless the other sidebar took over.
 * Sizes, the overlap rules and the phone sheet live in launchers.css; src/components/room/__tests__/sidebars-layout.test.ts guards them.
 */
import { useEffect, useRef, type RefObject } from 'react';

export type SidebarId = 'chat' | 'assistant';
export const ONE_AT_A_TIME = '(max-width: 1279px)';
export const FULL_SCREEN = '(max-width: 980px)';
const EVENT = 'room-sidebar-open';
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const matches = (q: string): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;

export function useSidebar({ id, open, close, panel, launcher, focusIn = true }: {
  id: SidebarId; open: boolean; close: () => void;
  panel: RefObject<HTMLElement | null>; launcher: RefObject<HTMLElement | null>;
  /** Move the focus into the panel when it opens (the assistant's chat does that itself). */
  focusIn?: boolean;
}): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const was = useRef(false);
  const yielded = useRef(false); // closed because the other sidebar opened: the focus is not ours to take back

  useEffect(() => {
    if (open && !was.current) {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
      if (focusIn) panel.current?.focus();
    } else if (!open && was.current && !yielded.current) {
      launcher.current?.focus();
    }
    if (!open) yielded.current = false;
    was.current = open;
  }, [open, id, focusIn, panel, launcher]);

  useEffect(() => {
    if (!open) return undefined;
    const onOther = (e: Event) => {
      if ((e as CustomEvent<SidebarId>).detail === id || !matches(ONE_AT_A_TIME)) return;
      yielded.current = true;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      const el = panel.current;
      if (!el) return;
      const at = document.activeElement;
      const modal = document.querySelector('[aria-modal="true"]:not([data-hp-sidebar])');
      if (e.key === 'Escape') {
        if (e.defaultPrevented || modal) return;
        const openOnes = Array.from(document.querySelectorAll<HTMLElement>('[data-hp-sidebar]:not([hidden])'));
        if (el.contains(at) || (openOnes.length === 1 && !openOnes.some((p) => p.contains(at)))) closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || modal || !matches(FULL_SCREEN)) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!el.contains(at)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (at === first || at === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener(EVENT, onOther);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener(EVENT, onOther); document.removeEventListener('keydown', onKey); };
  }, [open, id, panel]);
}
