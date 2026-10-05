'use client';

/**
 * A slim bar for every settlement that is waiting on the viewer's signature (from /api/me `pending`): the buyer who
 * closed the win dialog or reloaded, and the seller of a lot. Opens the PayModal.
 */
import { useTranslations } from 'next-intl';
import type { MeResponse } from '@/contracts';
import { useUsd } from '@/hooks/room/useUsd';
import './room.css';

export default function SettlementDesk({
  pending, lotNumbers, onOpen,
}: {
  pending: MeResponse['pending'];
  lotNumbers: ReadonlyMap<string, number>;
  onOpen: (settlementId: string, role: 'buyer' | 'seller', gross: string) => void;
}) {
  const t = useTranslations('room');
  const usd = useUsd();
  const open = pending.filter((p) => p.status === 'awaiting_payment' || p.status === 'awaiting_seller' || p.status === 'submitted');
  if (open.length === 0) return null;
  return (
    <section className="hp-desk" aria-label={t('desk.title')} data-testid="settlement-desk">
      {open.slice(0, 3).map((p) => (
        <div className="hp-desk-row" key={p.settlementId}>
          <span className="hp-desk-text">
            <strong>{t('desk.title')}</strong>{' '}
            {lotNumbers.has(p.lotId) ? `${t('desk.line', { number: String(lotNumbers.get(p.lotId)).padStart(2, '0'), amount: usd(p.gross) })}. ` : ''}
            {t(p.role === 'seller' ? 'desk.seller' : 'desk.buyer')}
          </span>
          <button type="button" className="hp-desk-btn" data-testid="desk-open" onClick={() => onOpen(p.settlementId, p.role, p.gross)}>{t('desk.open')}</button>
        </div>
      ))}
    </section>
  );
}
