'use client';

/**
 * A card on /verify/[lotId]: when the lot's show had its order drawn (or a thank-you draw), say so and link to the proof page. Added to
 * the lot page without changing anything of it. Renders nothing when the feature is off, the show had no draw, or the call fails.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { vrfOn } from '@/lib/client/features';
import { fetchShowDraws } from './client';
import './vrf.css';

/** The card claims a proof anyone can recompute, so it appears only for a draw that is revealed (a pending, committed or defaulted one has no such proof). */
export function cardDraws(draws: Awaited<ReturnType<typeof fetchShowDraws>>) {
  return {
    order: draws?.lotOrder && draws.lotOrder.status === 'revealed' ? draws.lotOrder : null,
    raffle: draws?.raffle && draws.raffle.status === 'revealed' ? draws.raffle : null,
  };
}

export default function LotOrderProof({ showId, locale }: { showId: string; locale: string }) {
  const t = useTranslations('vrf');
  const [draws, setDraws] = useState<Awaited<ReturnType<typeof fetchShowDraws>>>(null);
  useEffect(() => { if (!vrfOn()) return undefined; let live = true; void fetchShowDraws(showId).then((d) => { if (live) setDraws(d); }); return () => { live = false; }; }, [showId]);
  const { order, raffle } = cardDraws(draws);
  if (!order && !raffle) return null;
  return (
    <section className="vrf-lotcard" data-testid="vrf-lotcard">
      <h2>{t('lot.title')}</h2>
      <p>{t('lot.text')}</p>
      {order && <p><Link className="hp-inline-link" data-testid="vrf-lotcard-link" href={`/${locale}/verify/random/${order.requestId}`}>{t('lot.link')}</Link></p>}
      {raffle && <p><Link className="hp-inline-link" href={`/${locale}/verify/random/${raffle.requestId}`}>{t('lot.raffle')}</Link></p>}
    </section>
  );
}
