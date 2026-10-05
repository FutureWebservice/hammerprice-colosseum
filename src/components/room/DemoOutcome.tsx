'use client';

/**
 * What a person who just won, paid for or lost a DEMO lot is told: it ran with test money and a replica card, in a real room the card would
 * be theirs for real money, and where to go next (the real rooms, the sell flow). Demo rooms only; the settlement itself is untouched.
 *
 * `DemoOutcome` is the text and the two buttons (shown inside the win dialog and the paid sheet, which already show the card).
 * `DemoOutbidModal` is the same for a person outbid when the lot closed, with the card, name and grade.
 * `useLostLot` finds that lot once per lot.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDialog } from '@/hooks/room/useDialog';
import type { RoomLot } from '@/components/auction/types';
import '@/components/auction/win.css';

export type DemoOutcomeKind = 'won' | 'outbid';

export function DemoOutcome({ kind, locale, onNavigate }: { kind: DemoOutcomeKind; locale: string; onNavigate?: () => void }) {
  const t = useTranslations('room');
  return (
    <div className="hp-win-demo-outcome" data-testid="demo-outcome" data-kind={kind}>
      <p className="hp-win-demo-title">{t(`demoOutcome.${kind}Title`)}</p>
      <p>{t(`demoOutcome.${kind}Body`)}</p>
      <p><strong>{t('demoOutcome.try')}</strong></p>
      <div className="hp-win-actions">
        {/* /rooms has no demo filter: the anchor lands on the "Rooms from sellers" group, the real rooms. */}
        <Link href={`/${locale}/rooms#rm-sellers-title`} className="hp-win-rooms" data-testid="demo-browse" onClick={onNavigate}>{t('demoOutcome.browse')}</Link>
        <Link href={`/${locale}/sell`} className="hp-win-rooms" data-testid="demo-sell" onClick={onNavigate}>{t('demoOutcome.sell')}</Link>
      </div>
    </div>
  );
}

/** The first lot that closed with someone else on top after the viewer bid on it (see useLostLot); null when there is none. */
export function lostLotOf(lots: RoomLot[], bidOn: ReadonlySet<string> | undefined, seenOpen: ReadonlySet<string>, shown: ReadonlySet<string>): RoomLot | null {
  return lots.find((l) => (l.state === 'sold' || l.state === 'passed') && l.highBid != null && !l.highBidderIsMe && !!bidOn?.has(l.id) && seenOpen.has(l.id) && !shown.has(l.id)) ?? null;
}

/**
 * A lot of a demo room that closed with someone else on top, after the viewer had bid on it in this page session, once per lot.
 * Only a lot first seen open here counts, so a reload onto a long closed lot is not announced.
 */
export function useLostLot(lots: RoomLot[], bidOn: ReadonlySet<string> | undefined): { lost: RoomLot | null; dismiss: () => void } {
  const [lost, setLost] = useState<RoomLot | null>(null);
  const seenOpen = useRef<Set<string>>(new Set());
  const shown = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const l of lots) if (l.state === 'open') seenOpen.current.add(l.id);
    const l = lostLotOf(lots, bidOn, seenOpen.current, shown.current);
    if (!l) return;
    shown.current.add(l.id);
    setLost(l);
  }, [lots, bidOn]);
  return { lost, dismiss: () => setLost(null) };
}

export function DemoOutbidModal({ lot, locale, onClose }: { lot: RoomLot | null; locale: string; onClose: () => void }) {
  const t = useTranslations('room');
  const ref = useDialog<HTMLDivElement>(onClose);
  if (!lot) return null;
  const grade = [lot.gradingCompany, lot.grade].filter(Boolean).join(' ');
  return (
    <>
      <div className="hp-win-backdrop" onClick={onClose} />
      <div className="hp-win" ref={ref} role="dialog" aria-modal="true" aria-label={t('demoOutcome.outbidTitle')} data-testid="outbid-modal">
        <button type="button" className="hp-win-close" onClick={onClose} aria-label={t('win.close')}>×</button>
        {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
        {lot.imageUrl && <img className="hp-win-card" src={lot.imageUrl} alt={lot.name} decoding="async" />}
        <div className="hp-win-lot">
          <span className="hp-win-lotnumber">{t('catalogue.lotNumber', { number: String(lot.lotNumber).padStart(2, '0') })}</span>
          <h2 className="hp-win-name">{lot.name}</h2>
          {grade && <span className="hp-win-grade">{grade}</span>}
        </div>
        <DemoOutcome kind="outbid" locale={locale} onNavigate={onClose} />
        <div className="hp-win-actions">
          <button type="button" className="hp-win-dismiss" onClick={onClose}>{t('demoOutcome.dismiss')}</button>
        </div>
      </div>
    </>
  );
}
