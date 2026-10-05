'use client';

/**
 * "Help": one button with a short list: replay the tour, what the words mean, wallet help, questions and answers.
 * It carries data-tour="help", the anchor of the tour's last step. A disclosure (button plus list), not an ARIA menu,
 * so every entry is an ordinary link or button reachable with Tab; Escape closes it and returns focus to the button.
 * The links point at pages that exist (/about with the glossary at #glossary, the wallet help at #wallet, the FAQ at #faq).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { replayTour, tourMounted } from './tour-logic';
import '../explain/ux.css';

export default function HelpMenu({ className = '' }: { className?: string }) {
  const t = useTranslations('tour');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  // Only a page with a mounted tour (room, practice room, sell wizard) can replay one; elsewhere the entry is left out.
  const [canReplay, setCanReplay] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    const onDown = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open]);

  return (
    <div className={`ux-help ${className}`.trim()} ref={root}>
      <button ref={button} type="button" className="ux-help-btn" data-tour="help" data-testid="help-button" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={t('help.label')} onClick={() => { setCanReplay(tourMounted()); setOpen((v) => !v); }}>
        <span aria-hidden="true">?</span><span className="ux-help-text"> {t('help.button')}</span>
      </button>
      {open && (
        <ul className="ux-help-list" id={listId} data-testid="help-list">
          {canReplay && <li><button type="button" className="ux-help-item" data-testid="help-replay" onClick={() => { setOpen(false); replayTour(); }}>{t('help.replay')}</button></li>}
          <li><a className="ux-help-item" href={`/${locale}/about#glossary`}>{t('help.glossary')}</a></li>
          <li><a className="ux-help-item" href={`/${locale}/about#wallet`}>{t('help.wallet')}</a></li>
          <li><a className="ux-help-item" href={`/${locale}/about#faq`}>{t('help.faq')}</a></li>
        </ul>
      )}
    </div>
  );
}
