'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import type { RoomLot } from './types';
import { LimitIndicator, limitGap } from './Stage';
import { lotLimit, positiveAmount } from './limit';
import FairnessChip from '@/components/room/slots/FairnessChip';
import type { ShowOrder } from '@/contracts/vrf';
import { formatDurationLong } from '@/lib/auction/time-format';

function CatalogueLot({
  lot,
  current,
  t,
  usd,
  innerRef,
}: {
  lot: RoomLot;
  current: boolean;
  t: ReturnType<typeof useTranslations>;
  usd: (u: string | null | undefined) => string;
  innerRef?: React.Ref<HTMLLIElement>;
}) {
  const closed = lot.state === 'sold' || lot.state === 'passed' || lot.state === 'withdrawn';
  const reserve = positiveAmount(lot.reserve);
  const limit = lotLimit(lot);
  const belowReserve = lot.state === 'sold' && !lot.houseWon && reserve != null && lot.highBid != null && BigInt(lot.highBid) < BigInt(reserve);
  const stampLabel =
    lot.houseWon ? t('state.houseWon')
    : lot.state === 'sold' ? t(belowReserve ? 'state.hammeredBelowReserve' : 'state.hammered')
    : lot.state === 'passed' ? t('state.passed')
    : lot.state === 'withdrawn' ? t('state.withdrawn')
    : null;
  const wonByVisitor = lot.state === 'sold' && !!lot.highBidderIsMe;
  return (
    <li
      ref={innerRef}
      className={`ar-cat-lot${current ? ' is-current' : ''}${closed ? ` is-${lot.state}` : ''}`}
      aria-current={current ? 'true' : undefined}
    >
      {lot.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={lot.imageUrl} alt="" className="ar-cat-img" loading="lazy" decoding="async" />
      ) : (
        <div className="ar-cat-img" />
      )}
      <div className="ar-cat-body">
        <div className="ar-cat-no">{t('catalogue.lotNumber', { number: String(lot.lotNumber).padStart(2, '0') })}</div>
        <h3 className="ar-cat-name">{lot.name}</h3>
        {lot.gradingCompany && (
          <div className="ar-cat-grade">{lot.gradingCompany} {lot.grade}</div>
        )}
        <div className="ar-cat-est">
          {lot.state === 'sold' && !lot.houseWon ? (
            <>{t('catalogue.hammer')} <b>{usd(lot.highBid)}</b></>
          ) : limit.kind === 'none' ? (
            <b>{t('catalogue.noMinimum')}</b>
          ) : (
            <>{limit.kind === 'insured' ? t('catalogue.insured') : t('catalogue.estimate')} <b>{usd(limit.value)}</b></>
          )}
        </div>
        {lot.state === 'open' && limitGap(lot) && <LimitIndicator lot={lot} t={t} usd={usd} />}
        {stampLabel && (
          <div className="ar-stamp">
            {stampLabel}
            {wonByVisitor && ` · ${t('catalogue.toYou')}`}
          </div>
        )}
      </div>
    </li>
  );
}

export default function CatalogueRail({ lots, currentLotId, showId, order, lotDurationS, locale = 'en' }: { lots: RoomLot[]; currentLotId: string | null; showId?: string; order?: ShowOrder; /** Seconds each lot runs (a live show); absent = say nothing. */ lotDurationS?: number; locale?: string }) {
  const t = useTranslations('room');
  const usd = useUsd();
  const currentRef = useRef<HTMLLIElement | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => setReducedMotion(mql.matches);
    decide();
    mql.addEventListener('change', decide);
    return () => mql.removeEventListener('change', decide);
  }, []);

  // The current lot needs to be obviously on screen, not just obviously styled - a catalogue
  // long enough to scroll would otherwise leave a visitor staring at lot 2 while lot 14 is on
  // the block. Only the catalogue's own scrollers move (the rail on a desktop, the horizontal list on a phone), and only when the
  // row is out of view: scrollIntoView would also scroll the whole page on a phone, away from the stage and the bid bar.
  useEffect(() => {
    const el = currentRef.current;
    if (!el) return;
    const behavior = reducedMotion ? 'auto' : 'smooth';
    for (const box of [el.closest<HTMLElement>('.ar-cat-list'), el.closest<HTMLElement>('.ar-cat')]) {
      if (!box) continue;
      const a = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const dx = a.left < b.left ? a.left - b.left : a.right > b.right ? a.right - b.right : 0;
      const dy = a.top < b.top ? a.top - b.top : a.bottom > b.bottom ? a.bottom - b.bottom : 0;
      if (dx || dy) box.scrollBy({ left: box.scrollWidth > box.clientWidth ? dx : 0, top: box.scrollHeight > box.clientHeight ? dy : 0, behavior });
    }
  }, [currentLotId, reducedMotion]);

  return (
    <aside className="ar-cat" aria-label={t('a11y.catalogue')} data-tour="rail">
      <h2 className="ar-cat-head">{t('catalogue.head', { count: lots.length })}</h2>
      {lotDurationS != null && <p className="ar-cat-rule" data-testid="lot-duration-note">{t('catalogue.lotRule', { duration: formatDurationLong(lotDurationS, locale) })}</p>}
      {showId && order && <FairnessChip showId={showId} order={order} />}
      {lots.length === 0 && <p className="ar-feed-empty">{t('catalogue.empty')}</p>}
      <ul className="ar-cat-list" tabIndex={0}>
        {lots.map((lot) => {
          const current = lot.id === currentLotId;
          return <CatalogueLot key={lot.id} lot={lot} current={current} t={t} usd={usd} innerRef={current ? currentRef : undefined} />;
        })}
      </ul>
    </aside>
  );
}
