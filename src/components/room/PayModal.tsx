'use client';

/**
 * The payment sheet for ONE settlement, for either role.
 * The buyer sees a calm summary and one button. The signing round, which has a clock, and the wallet prompt start only
 * when the buyer presses it; while the wallet is open the sheet says so and counts down; a round that ends unsigned
 * leaves one "Try again" button, and the next press prepares a fresh round without a reload.
 * The seller's wallet opens by itself once, when the buyer's round is open for them.
 * Nothing is asked of a wallet that the decoded transaction does not justify (SettlementReview, settle.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDialog } from '@/hooks/room/useDialog';
import { useNow } from '@/hooks/room/useNow';
import { useUsd } from '@/hooks/room/useUsd';
import { useSettlement, type SettleFailure } from '@/hooks/useSettlement';
import { errorKey, SETTLE_ERROR_CODES } from '@/lib/client/bidder';
import type { Tr } from '@/components/auction/model';
import WalletPromptHint, { markHintConfirmed } from '@/components/explain/WalletPromptHint';
import { normalizeCluster } from '@/lib/auth/config';
import FaucetButton from '@/components/account/FaucetButton';
import type { RoomLot } from '@/components/auction/types';
import SettlementReview from './SettlementReview';
import { DemoOutcome } from './DemoOutcome';
import './room.css';

function failureText(t: Tr, f: SettleFailure): string {
  switch (f.kind) {
    case 'review': return t('errors.review');
    case 'validator': return t('errors.validator');
    case 'wallet_modified': return t('errors.walletModified');
    case 'wallet': return t(`errors.wallet${(f.wallet ?? 'unknown').charAt(0).toUpperCase()}${(f.wallet ?? 'unknown').slice(1)}`);
    case 'load': return t('errors.load');
    default: return t(errorKey(f.code, SETTLE_ERROR_CODES));
  }
}

const clusterHint = (f: SettleFailure) => (f.kind === 'wallet' && f.wallet === 'cluster') || f.code === 'simulation_failed';

export default function PayModal({
  settlementId, demoLot, cluster, agreedGross, locale, serverOffset, onFunded, onClose,
}: {
  settlementId: string;
  /** Set (a lot or null) in the demo room only: once the buyer's payment settled, the card and the "this was a demo" explanation are shown. Undefined elsewhere. */
  demoLot?: RoomLot | null;
  cluster: string | null;
  /** The price the buyer agreed to (the lot's final high bid), for the decoded-price check. Null on the seller side. */
  agreedGross: string | null;
  locale: string;
  /** serverNow minus client time, ms (clock.ts). */
  serverOffset: number;
  /** Devnet: test USDC was claimed from the "not enough USDC" message; the room re-reads the balance. */
  onFunded?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('settlement');
  const usd = useUsd();
  const ref = useDialog<HTMLDivElement>(onClose);
  const now = useNow(500);
  const nowRef = useRef(0);
  nowRef.current = (now ?? Date.now()) + serverOffset;
  const nowMs = useCallback(() => nowRef.current, []);
  const { view, state, step, review, failure, busy, sign } = useSettlement(settlementId, { cluster, agreedGross, nowMs });
  // The "not enough USDC" failure that the test USDC answered: its message goes, the button stays "Try again" (the next press prepares a fresh round).
  const [fundedFor, setFundedFor] = useState<SettleFailure | null>(null);
  const shown = failure && failure !== fundedFor ? failure : null;

  // The seller's wallet opens by itself, once per round, when the buyer's round is open for them. The buyer's never does.
  const tried = useRef<string>('');
  useEffect(() => {
    if (!view || !state || busy || failure || view.role !== 'seller') return;
    const key = `${view.id}:${view.attempt}`;
    if (state.kind === 'sign_now' && tried.current !== key) { tried.current = key; void sign(); }
  }, [view, state, busy, failure, sign]);

  // The wallet prompt of a round was approved once the signature is on its way: from then on the hint above the button is one quiet line.
  useEffect(() => {
    if (step === 'wait' && !failure) markHintConfirmed('pay');
  }, [step, failure]);

  const due = view && now != null
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(view.dueAt))
    : null;
  const again = step === 'retry' || step === 'lapsed';
  const label = step === 'preparing' ? t('actions.preparing')
    : step === 'confirm' ? t('actions.signing')
    : again ? t('actions.retry')
    : view?.role === 'seller' ? t('actions.confirmSale')
    : t('actions.pay', { amount: usd(view?.gross) });
  const showButton = step === 'start' || step === 'preparing' || step === 'confirm' || again;

  return (
    <>
      <div className="hp-sheet-backdrop" onClick={onClose} />
      <div className="hp-sheet hp-pay" ref={ref} role="dialog" aria-modal="true" aria-label={t(view?.role === 'seller' ? 'titleSeller' : 'titleBuyer')} data-testid="pay-modal">
        <div className="hp-sheet-head">
          <h2 className="hp-sheet-title">{t(view?.role === 'seller' ? 'titleSeller' : 'titleBuyer')}</h2>
          <button type="button" className="hp-sheet-close" onClick={onClose} aria-label={t('actions.close')}>×</button>
        </div>

        <SettlementReview view={view} state={state} step={step} review={review} usd={usd} locale={locale} dueText={due} />

        {demoLot !== undefined && view?.role === 'buyer' && state?.kind === 'settled' && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
            {demoLot?.imageUrl && <img className="hp-win-card" src={demoLot.imageUrl} alt={demoLot.name} decoding="async" style={{ display: 'block', margin: '0 auto 12px' }} />}
            {demoLot && <p className="hp-win-name" data-testid="demo-paid-card">{demoLot.name}{[demoLot.gradingCompany, demoLot.grade].filter(Boolean).length > 0 ? `, ${[demoLot.gradingCompany, demoLot.grade].filter(Boolean).join(' ')}` : ''}</p>}
            <DemoOutcome kind="won" locale={locale} onNavigate={onClose} />
          </>
        )}

        {shown && (
          <p className="hp-sheet-error" role="alert" data-testid="settle-error">
            {failureText(t as Tr, shown)}
            {cluster === 'devnet' && shown.code === 'insufficient_usdc' && <> <FaucetButton onDone={() => { setFundedFor(shown); onFunded?.(); }} /></>}
          </p>
        )}
        {shown && clusterHint(shown) && (
          <div className="hp-settle-cluster" data-testid="cluster-help">
            <strong>{t('cluster.title')}</strong>
            <p>{t('cluster.body')}</p>
            <ol><li>{t('cluster.step1')}</li><li>{t('cluster.step2')}</li><li>{t('cluster.step3')}</li></ol>
          </div>
        )}

        {view?.role !== 'seller' && showButton && <WalletPromptHint kind="pay" cluster={normalizeCluster(cluster)} />}
        <div className="hp-sheet-actions">
          <button type="button" className="hp-sheet-secondary" onClick={onClose}>{t('actions.close')}</button>
          {showButton && (
            <button type="button" className={`hp-sheet-primary${again || step === 'start' ? ' is-big' : ''}`} data-testid="sign-button" disabled={step === 'preparing' || step === 'confirm'} onClick={() => void sign()}>
              {label}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
