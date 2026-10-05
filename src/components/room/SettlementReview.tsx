'use client';

/**
 * What both parties see while a settlement is open: the round state ("round open, N s left", "waiting for the
 * seller", "sign now", "settled", "expired"), and the figures of the transaction they are about to sign, read
 * from the transaction bytes (src/lib/client/settle.ts decodeSettlementTx), not from the server's JSON.
 * Presentational: PayModal owns the data and the buttons.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { SettlementView } from '@/contracts';
import { shortWallet } from '@/components/auction/types';
import { explorerTxUrl } from '@/lib/client/explorer';
import type { PayStep, ReviewedSettlement, RoundState } from '@/lib/client/settle';
import './room.css';

type Tr = ReturnType<typeof useTranslations>;

/** The one plain sentence at the top of the sheet. */
export function stepText(t: Tr, step: PayStep, s: RoundState | null, role: 'buyer' | 'seller' | null): string {
  switch (step) {
    case 'loading': return t('state.loading');
    case 'start': return t(role === 'seller' ? 'state.readySeller' : 'state.readyBuyer');
    case 'preparing': return t('state.preparing');
    case 'confirm': return t('state.signNow');
    case 'retry': return t('state.retry');
    case 'lapsed': return t('state.lapsed');
    case 'wait':
      if (s?.kind === 'waiting') return t(s.on === 'seller' ? 'state.waitingSeller' : 'state.waitingBuyer', { seconds: s.secondsLeft });
      return t('state.submitted');
    case 'done': return t(`state.${s?.kind === 'settled' || s?.kind === 'expired' || s?.kind === 'failed' ? s.kind : 'failed'}`);
  }
}

export default function SettlementReview({
  view, state, step, review, usd, locale, dueText,
}: {
  view: SettlementView | null;
  state: RoundState | null;
  step: PayStep;
  review: ReviewedSettlement | null;
  usd: (u: string | null | undefined) => string;
  locale: string;
  /** Preformatted end of the settlement window, or null. */
  dueText: string | null;
}) {
  const t = useTranslations('settlement');
  const seconds = state && (state.kind === 'sign_now' || state.kind === 'waiting') ? state.secondsLeft : null;
  const role = view?.role ?? null;
  const over = step === 'done';
  const explorer = view?.explorerUrl ?? (view?.txSignature ? explorerTxUrl(view.txSignature, view.cluster) : null);

  return (
    <div className="hp-settle" data-testid="settlement-review">
      <div className="hp-settle-status">
        {role && <span className="hp-settle-role">{t(`roles.${role}`)}</span>}
        <span className={`hp-settle-state${step === 'confirm' ? ' is-now' : ''}`} role="status" aria-live="polite" data-testid="settlement-status" data-state={state?.kind ?? 'loading'} data-step={step}>
          {stepText(t, step, state, role)}
        </span>
        {seconds != null && (step === 'confirm' || step === 'wait') && <span className="hp-settle-timer" data-testid="round-timer" aria-label={t('state.timeLeft', { seconds })}>{seconds} s</span>}
      </div>

      {state?.kind === 'settled' && role && <p className="hp-settle-outcome is-good">{t(role === 'seller' ? 'outcome.settledSeller' : 'outcome.settledBuyer')}</p>}
      {state?.kind === 'expired' && <p className="hp-settle-outcome is-bad">{t('outcome.lapsed')}</p>}
      {state?.kind === 'failed' && <p className="hp-settle-outcome is-bad">{t('outcome.failed')}</p>}

      {review ? <h3 className="hp-settle-head">{t('review.heading')}</h3> : view && !over && <h3 className="hp-settle-head">{t('summary.heading')}</h3>}
      {review ? (
        <>
          <dl className="hp-settle-rows" data-testid="settlement-figures">
            <div><dt>{t('review.youPay')}</dt><dd data-testid="review-gross">{usd(review.gross.toString())}</dd></div>
            <div><dt>{t('review.sellerReceives')}</dt><dd>{usd(review.toSeller.toString())}</dd></div>
            <div><dt>{t('review.fee')}</dt><dd>{usd(review.toFeeWallet.toString())}</dd></div>
            {review.toRoyalty > 0n && <div><dt>{t('review.royalty')}</dt><dd>{usd(review.toRoyalty.toString())}</dd></div>}
          </dl>
          <details className="hp-settle-tech" data-testid="settlement-tech">
            <summary>{t('review.technical')}</summary>
            <dl className="hp-settle-rows">
              <div><dt>{t('review.card')}</dt><dd className="is-mono">{review.asset ? shortWallet(review.asset) : '-'}</dd></div>
              <div><dt>{t('review.cardTo')}</dt><dd className="is-mono">{review.buyer ? shortWallet(review.buyer) : '-'}</dd></div>
              {review.bidLogHash && (
                <div>
                  <dt>{t('review.memo')}</dt>
                  <dd className="is-mono">
                    {review.bidLogHash.slice(0, 10)}…{' '}
                    {view && <Link className="hp-inline-link" href={`/${locale}/verify/${view.lotId}`}>{t('review.verify')}</Link>}
                  </dd>
                </div>
              )}
            </dl>
          </details>
          <p className="hp-settle-note">{t('review.note')}</p>
          {review.ok && <p className="hp-settle-ok">{t('review.ok')}</p>}
          {!review.ok && (
            <ul className="hp-settle-problems" role="alert" data-testid="review-problems">
              {review.problems.map((p) => (
                <li key={p}>{t(`review.problems.${p}`, { role: role ? t(`roles.${role}`) : '' })}</li>
              ))}
            </ul>
          )}
        </>
      ) : view && !over ? (
        // Before anything is asked of the wallet: the figures the server shows. The decoded ones replace them once the round is prepared.
        <dl className="hp-settle-rows" data-testid="settlement-summary">
          <div><dt>{t('review.youPay')}</dt><dd>{usd(view.gross)}</dd></div>
          <div><dt>{t('summary.fee')}</dt><dd>{usd(view.platformFee)}</dd></div>
          <div><dt>{t('review.sellerReceives')}</dt><dd>{usd(view.sellerAmount)}</dd></div>
        </dl>
      ) : null}

      <p className="hp-settle-note">{t('review.gas')}</p>
      {dueText && <p className="hp-settle-note">{t('window.due', { time: dueText })}</p>}
      {!over && <p className="hp-settle-note">{t('window.note')}</p>}

      {explorer && (
        <a className="hp-settle-explorer" href={explorer} target="_blank" rel="noopener noreferrer" data-testid="explorer-link">{t('actions.explorer')}</a>
      )}
    </div>
  );
}
