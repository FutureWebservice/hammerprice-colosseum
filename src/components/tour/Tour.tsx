'use client';

/**
 * The first-visit tour: five short steps, one small card at a time, next to the thing it explains. It never covers
 * the page with an overlay and never takes focus, so the person can keep bidding while it is open: the card is a
 * plain fixed element, the anchor only gets an outline. It starts once (hp.tour.v1), `?tour=0` turns that off,
 * Escape or "Skip" ends it, and HelpMenu replays it. A page marks its elements with data-tour (see steps.ts) and mounts <Tour flow="room|sell" />.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { placeNear } from '@/lib/client/place';
import type { TourFlow } from './steps';
import { findAnchor, useTour } from './useTour';
import { setTourMounted } from './tour-logic';
import '../explain/ux.css';

export default function Tour({ autoStart = true, flow = 'room' }: { autoStart?: boolean; flow?: TourFlow }) {
  const t = useTranslations('tour');
  const { id, n, total, hasNext, hasBack, next, back, stop } = useTour(autoStart, flow);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => { setTourMounted(true); return () => setTourMounted(false); }, []);

  // Put the card next to its anchor, mark the anchor, and follow it on scroll and resize.
  useLayoutEffect(() => {
    if (!id || !card.current) return undefined;
    const el = card.current;
    const anchor = findAnchor(id, flow);
    if (!anchor) return undefined;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    anchor.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    anchor.setAttribute('data-tour-active', 'true');
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const p = placeNear(r, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
      el.style.top = `${p.top}px`;
      el.style.left = `${p.left}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      anchor.removeAttribute('data-tour-active');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [id, flow]);

  useEffect(() => {
    if (!id) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, stop]);

  if (!id) return null;
  return createPortal(
    <div ref={card} className="ux-tour" role="dialog" aria-modal="false" aria-label={t('tour.label')} data-testid="tour" data-step={id}>
      <p className="ux-tour-count">{t('tour.progress', { n, total })}</p>
      <p className="ux-tour-text" aria-live="polite">{t(`tour.steps.${id}`)}</p>
      <div className="ux-tour-actions">
        <button type="button" className="ux-btn ux-btn-quiet" onClick={stop} data-testid="tour-skip">{t('tour.skip')}</button>
        {hasBack && <button type="button" className="ux-btn" onClick={back} data-testid="tour-back">{t('tour.back')}</button>}
        <button type="button" className="ux-btn ux-btn-main" onClick={hasNext ? next : stop} data-testid="tour-next">{hasNext ? t('tour.next') : t('tour.done')}</button>
      </div>
    </div>,
    document.body,
  );
}
