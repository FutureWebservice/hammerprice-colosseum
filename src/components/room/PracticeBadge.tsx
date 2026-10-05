'use client';

/**
 * LEGACY (see PracticeRoom.tsx; the DEMO label of the house room is DemoBadge.tsx). The label the practice room wears next to the live state: what this room is, and a popover that says what is
 * real and what is simulated, linking to /about#features.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import './room.css';

export default function PracticeBadge({ locale }: { locale: string }) {
  const t = useTranslations('room');
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  return (
    <span className="hp-practice" ref={box} data-testid="practice-pill">
      <button type="button" className="hp-practice-pill" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className="hp-practice-long">{t('practice.pill')}</span>
        <span className="hp-practice-short">{t('practice.pillShort')}</span>
        <span className="hp-practice-i" aria-hidden="true">i</span>
        <span className="hp-sr">{t('practice.more')}</span>
      </button>
      {open && (
        <div id={id} className="hp-practice-pop" role="group" aria-label={t('practice.title')}>
          <p><b>{t('practice.real')}</b></p>
          <p>{t('practice.simulated')}</p>
          <Link href={`/${locale}/about#features`} className="hp-practice-link">{t('practice.link')}</Link>
        </div>
      )}
    </span>
  );
}
