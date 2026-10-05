'use client';

/**
 * The floating "how it works" control - always visible, on every page including the room
 * (mounted once in SiteChrome.tsx). Opens a modal that steps through the concept in
 * pictures, then a short FAQ; see ExplainContent.tsx for the shared body.
 */
import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { defaultLocale, getLocaleFromPath } from '@/lib/i18n';
import './explain.css';

// The dialog (and the explain texts of both languages it reads, about 45 kB of script) loads when it is first wanted, not with every page.
const loadDialog = () => import('./ExplainDialog');
const ExplainDialog = dynamic(loadDialog, { ssr: false });

function GavelGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 5l6 6" />
      <rect x="2.5" y="1.5" width="7" height="4.5" rx="1" transform="rotate(-45 6 3.75)" />
      <path d="M10 9l7 7" />
      <path d="M12.5 18v3.5M8.5 21.5h7" />
    </svg>
  );
}

export default function ExplainBubble({ label }: { label: string }) {
  const pathname = usePathname();
  const locale = getLocaleFromPath(pathname || '') ?? defaultLocale;

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ex-bubble"
        onClick={() => setOpen(true)}
        onPointerEnter={() => void loadDialog()}
        onFocus={() => void loadDialog()}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
      >
        <GavelGlyph />
        <span>{label}</span>
      </button>

      {open && <ExplainDialog locale={locale} onClose={close} />}
    </>
  );
}
