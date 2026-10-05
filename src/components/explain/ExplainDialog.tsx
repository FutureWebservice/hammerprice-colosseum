'use client';

/**
 * The explain bubble's dialog: the concept in pictures, then the FAQ (ExplainContent). Split from ExplainBubble.tsx so that the bubble itself, which is on
 * every page, does not carry the texts of both languages; this loads on the first click, hover or focus of the bubble.
 */
import { useEffect, useRef } from 'react';
import type { Locale } from '@/lib/i18n';
import { getExplainMessages } from './content';
import ExplainContent from './ExplainContent';

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export default function ExplainDialog({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const messages = getExplainMessages(locale);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="ex-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="ex-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ex-modal-title"
        tabIndex={-1}
      >
        <div className="ex-dialog-head">
          <h2 id="ex-modal-title">{messages.modal.title}</h2>
          <button type="button" className="ex-close" onClick={onClose} aria-label={messages.modal.close}>
            <CloseGlyph />
          </button>
        </div>
        <ExplainContent messages={messages} />
      </div>
    </div>
  );
}
