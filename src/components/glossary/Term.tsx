'use client';

/**
 * <Term id="usdc">USDC</Term>: a word with a dotted underline that explains itself. A click, Enter or Space on the
 * button opens a small card (role=dialog) with one sentence from glossary.json; Escape, a click outside or the Close
 * button closes it and focus returns to the word. On a phone the card is a bottom sheet (see ux.css). A term that
 * does not exist on this network (test network, test USDC, replica on mainnet) renders as plain text.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocale } from 'next-intl';
import type { Cluster } from '@/contracts';
import { useDialog } from '@/hooks/room/useDialog';
import { placeNear } from '@/lib/client/place';
import { useGlossary } from './useGlossary';
import type { GlossaryId } from './terms';
import '../explain/ux.css';

function Card({ id, domId, anchor, onClose, cluster }: { id: GlossaryId; domId: string; anchor: HTMLElement; onClose: () => void; cluster?: Cluster }) {
  const g = useGlossary(cluster);
  const locale = useLocale();
  const ref = useDialog<HTMLDivElement>(onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const place = () => {
      const p = placeNear(anchor.getBoundingClientRect(), { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
      el.style.top = `${p.top}px`;
      el.style.left = `${p.left}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, ref]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n) && !anchor.contains(n)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [anchor, onClose, ref]);

  return createPortal(
    <div ref={ref} id={domId} className="ux-pop" role="dialog" aria-modal="false" aria-labelledby={`${domId}-t`} aria-describedby={`${domId}-d`} data-testid="term-pop" data-term={id}>
      <p className="ux-pop-kicker">{g.title}</p>
      <p className="ux-pop-title" id={`${domId}-t`}>{g.label(id)}</p>
      <p className="ux-pop-text" id={`${domId}-d`}>{g.text(id)}</p>
      <div className="ux-pop-foot">
        <a className="ux-pop-link" href={`/${locale}/about#glossary`}>{g.faq}</a>
        <button type="button" className="ux-btn" onClick={onClose} data-testid="term-close">{g.close}</button>
      </div>
    </div>,
    document.body,
  );
}

export default function Term({ id, children, cluster }: { id: GlossaryId; children?: ReactNode; cluster?: Cluster }) {
  const g = useGlossary(cluster);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const domId = useId();
  const close = useCallback(() => setOpen(false), []);

  if (!g.has(id)) return <>{children ?? g.label(id)}</>;
  return (
    <>
      <button ref={button} type="button" className="ux-term" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? domId : undefined} data-testid="term" data-term={id} onClick={() => setOpen((v) => !v)}>
        {children ?? g.label(id)}
      </button>
      {open && button.current && <Card id={id} domId={domId} anchor={button.current} onClose={close} cluster={cluster} />}
    </>
  );
}
