'use client';

/**
 * The payoff screen, opened once per lot the viewer wins.
 *
 * Real room: the hammer, then the settlement as it stands (payment due, settling, settled, not completed), a
 * button into the PayModal, and the explorer receipt once it settled. Practice room: the same screen with the
 * "nothing here was real" sentence directly under the headline and next steps instead of a payment.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDialog } from '@/hooks/room/useDialog';
import { useUsd } from '@/hooks/room/useUsd';
import { explorerTxUrl } from '@/lib/client/explorer';
import type { RoomLot } from './types';
import FeeBreakdown from './FeeBreakdown';
import { DemoOutcome } from '@/components/room/DemoOutcome';
import './win.css';

export interface Won { lot: RoomLot; amount: bigint }

/**
 * Finds a lot that sold to the viewer, exactly once per lot. `bidOn` holds the lots the viewer actually bid on in
 * this page session, so a reload cannot celebrate a lot that was merely watched (the pay bar covers that case).
 * The win is a fact about a lot, not a moment on the clock, so this watches the lots rather than the standing.
 */
export function useWonLot(lots: RoomLot[], bidOn: ReadonlySet<string> | undefined): { won: Won | null; dismiss: () => void } {
  const [won, setWon] = useState<Won | null>(null);
  const shown = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const l of lots) {
      if (l.state !== 'sold' || !l.highBidderIsMe || !bidOn?.has(l.id) || shown.current.has(l.id)) continue;
      shown.current.add(l.id);
      setWon({ lot: l, amount: BigInt(l.highBid ?? '0') });
      return;
    }
  }, [lots, bidOn]);
  return { won, dismiss: () => setWon(null) };
}

type Phase = 'pending' | 'awaiting' | 'windowEnded' | 'submitted' | 'settled' | 'lapsed';

/**
 * True once the payment window (`dueAt`, an ISO time from /api/me `pending`) has passed on the server clock. The server books the expiry lazily
 * (on the next read), so until then the lot still says "awaiting"; the dialog does not wait for that.
 */
export function windowEnded(dueAt: string | null | undefined, nowMs: number | null | undefined): boolean {
  if (!dueAt || nowMs == null) return false;
  const due = Date.parse(dueAt);
  return Number.isFinite(due) && due <= nowMs;
}

/** `ended`: the payment window has passed (see windowEnded). It only changes the open "awaiting" state; a payment already submitted or settled is never turned back. */
export function settlementPhase(s: RoomLot['settlement'], ended = false): Phase {
  if (!s) return 'pending';
  if (s.status === 'settled') return 'settled';
  if (s.status === 'submitted') return 'submitted';
  if (s.status === 'expired' || s.status === 'failed') return 'lapsed';
  return ended ? 'windowEnded' : 'awaiting';
}

export default function WinModal({
  won, lots, practice, demo = false, cluster, locale, solUsd = null, dueAtBySettlement, nowMs = null, onPay, onClose,
}: {
  won: Won | null;
  /** All lots as the room sees them: the modal follows the settlement status of the won lot live. */
  lots: RoomLot[];
  practice: boolean;
  /** A demo (house) room: after the hammer the dialog explains that the money and the card were test ones, and points to the real rooms. */
  demo?: boolean;
  cluster: string | null;
  locale: string;
  solUsd?: number | null;
  /** Payment deadlines by settlement id, remembered from /api/me (which stops listing a settlement once it is overdue). */
  dueAtBySettlement?: ReadonlyMap<string, string>;
  /** The server clock now, in ms (null before mount). Together with the deadline it shows the "payment window ended" state without waiting for the server to book the expiry. */
  nowMs?: number | null;
  onPay: (settlementId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('room');
  const usd = useUsd();
  const ref = useDialog<HTMLDivElement>(onClose);
  if (!won) return null;

  const lot = lots.find((l) => l.id === won.lot.id) ?? won.lot;
  const grade = [lot.gradingCompany, lot.grade].filter(Boolean).join(' ');
  const reserve = lot.reserve != null ? BigInt(lot.reserve) : null;
  const belowLimit = reserve != null && won.amount < reserve;
  const phase = settlementPhase(lot.settlement, lot.settlement ? windowEnded(dueAtBySettlement?.get(lot.settlement.id), nowMs) : false);
  const receipt = lot.settlement?.txSignature ? explorerTxUrl(lot.settlement.txSignature, cluster) : null;

  return (
    <>
      <div className="hp-win-backdrop" onClick={onClose} />
      <div className="hp-win" ref={ref} role="dialog" aria-modal="true" aria-label={t('win.title')} data-testid="win-modal">
        <button type="button" className="hp-win-close" onClick={onClose} aria-label={t('win.close')}>×</button>

        <p className="hp-win-call">{t('win.call')}</p>
        {practice && <p className="hp-win-demo" data-testid="win-practice-note">{t('win.practiceNote')}</p>}

        {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
        {lot.imageUrl && <img className="hp-win-card" src={lot.imageUrl} alt={lot.name} decoding="async" />}

        <div className="hp-win-lot">
          <span className="hp-win-lotnumber">{t('catalogue.lotNumber', { number: String(lot.lotNumber).padStart(2, '0') })}</span>
          <h2 className="hp-win-name">{lot.name}</h2>
          {grade && <span className="hp-win-grade">{grade}</span>}
        </div>

        <div className="hp-win-price">{usd(won.amount.toString())}</div>
        {!practice && <p className="hp-win-outcome">{t('win.outcome')}</p>}
        {belowLimit && <p className="hp-win-belowlimit">{t('state.hammeredBelowReserve')}</p>}

        {!practice && (
          <p className={`hp-win-status is-${phase}`} role="status" data-testid="win-settlement-status" data-phase={phase}>{t(`win.status.${phase}`)}</p>
        )}

        {/* The main action sits above the fee table so it is on screen without scrolling the card. */}
        {!practice && phase === 'awaiting' && lot.settlement && (
          <button type="button" className="hp-win-pay" data-testid="win-pay" onClick={() => onPay(lot.settlement!.id)}>{t('win.pay')}</button>
        )}

        {demo && !practice && <DemoOutcome kind="won" locale={locale} onNavigate={onClose} />}

        <FeeBreakdown amountBaseUnits={won.amount.toString()} solUsd={solUsd} devnet={cluster === 'devnet'} won />

        <div className="hp-win-actions">
          {receipt && <a className="hp-win-rooms" href={receipt} target="_blank" rel="noopener noreferrer" data-testid="explorer-link">{t('win.receipt')}</a>}
          {!practice && lot.settlement && (
            <details className="hp-win-tech">
              <summary>{t('win.technical')}</summary>
              <Link href={`/${locale}/verify/${lot.id}`} className="hp-win-rooms" onClick={onClose}>{t('win.verify')}</Link>
            </details>
          )}
          <button type="button" className="hp-win-dismiss" onClick={onClose}>{t('win.dismiss')}</button>
          {practice ? (
            <>
              <Link href={`/${locale}/rooms`} className="hp-win-rooms" onClick={onClose}>{t('win.practiceNext')}</Link>
              <Link href={`/${locale}/sell`} className="hp-win-rooms" onClick={onClose}>{t('win.listYours')}</Link>
            </>
          ) : demo ? null : (
            <Link href={`/${locale}/rooms`} className="hp-win-rooms" onClick={onClose}>{t('win.viewRooms')}</Link>
          )}
        </div>
      </div>
    </>
  );
}
