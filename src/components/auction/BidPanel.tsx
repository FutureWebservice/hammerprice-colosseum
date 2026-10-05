'use client';

/**
 * The confirmation step before a binding bid: what lot, the three numbers that decide the outcome (current bid,
 * your bid, the reserve), where the bid lands against the reserve, what you owe if you win, the viewer's USDC
 * balance, and (practice room only) that nothing here is real money. The confirm button carries the binding
 * label: DE "Verbindlich bieten, zahlungspflichtig", EN "Place binding bid, payment due if you win".
 *
 * Anchored above the slab on desktop, a bottom sheet on mobile (announcer.css). The panel scrolls inside
 * itself with a sticky title and a sticky confirm button, so neither is ever clipped under the topbar.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { bidStanding } from '@/lib/bidding';
import { useDialog } from '@/hooks/room/useDialog';
import { useUsd } from '@/hooks/room/useUsd';
import type { RoomLot } from './types';
import { positiveAmount } from './limit';
import FeeBreakdown from './FeeBreakdown';
import FaucetButton from '@/components/account/FaucetButton';

export default function BidPanel({
  lot, nextAmount, pending, error, fundsShort = false, practice, balance = null, devnet = false, locale, solUsd = null, fromLink = null, onFunded, onConfirm, onClose,
}: {
  lot: RoomLot;
  /** The exact next bid, in USDC base units: what confirming actually commits to. */
  nextAmount: bigint;
  pending: boolean;
  /** An already translated error sentence, or null. */
  error: string | null;
  /** The error is the server's "your USDC does not cover this bid": on devnet the Get test USDC button sits next to it. */
  fundsShort?: boolean;
  /** The practice room gets the "this is not real" sentence and a plain button label. */
  practice: boolean;
  /** The viewer's USDC (base units); `usdc: null` = unreadable right now; omit for the practice room. */
  balance?: { usdc: string | null } | null;
  devnet?: boolean;
  locale: string;
  solUsd?: number | null;
  /** The panel was opened from a room link with an amount in it (a Telegram lot alert): says where the amount comes from, and that nothing is placed before the confirm. */
  fromLink?: 'used' | 'adjusted' | null;
  /** Devnet: the test USDC was claimed from the panel (re-read the balance, drop the error). */
  onFunded?: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('room');
  const usd = useUsd();
  const ref = useDialog<HTMLDivElement>(onClose);

  const reserve = lot.reserve != null ? BigInt(lot.reserve) : null;
  const highBid = lot.highBid != null ? BigInt(lot.highBid) : null;
  const standing = bidStanding({ amount: nextAmount, highBid, reserve });
  const standingText = reserve == null
    ? t('bidPanel.noLimit')
    : standing.clearsReserve
      ? t('bidPanel.meetsLimit')
      : t('bidPanel.belowLimit', { amount: usd(standing.shortfall!.toString()) });
  const low = balance?.usdc != null && BigInt(balance.usdc) < nextAmount;
  // One Get test USDC button, devnet only: beside the server's "not enough USDC" error, else beside the low-balance line.
  const faucetAtError = devnet && fundsShort && !!error;
  const faucetAtBalance = devnet && low && !faucetAtError;

  return (
    <>
      <div className="hp-bidpanel-backdrop" onClick={onClose} />
      <div className="hp-bidpanel" ref={ref} role="dialog" aria-modal="true" aria-label={t('bidPanel.title')} data-testid="bid-panel">
        <div className="hp-bidpanel-head">
          <h2 className="hp-bidpanel-title">{t('bidPanel.titleAmount', { amount: usd(nextAmount.toString()) })}</h2>
          <button type="button" className="hp-bidpanel-close" onClick={onClose} aria-label={t('bidPanel.close')}>×</button>
        </div>

        {fromLink && <p className="hp-bidpanel-fromlink" role="status" data-testid="bid-from-link">{t(fromLink === 'used' ? 'bidPanel.fromLink' : 'bidPanel.fromLinkAdjusted')}</p>}

        <div className="hp-bidpanel-lot">{t('bidPanel.lotLine', { number: String(lot.lotNumber).padStart(2, '0'), name: lot.name })}</div>

        <div className="hp-bidpanel-numbers">
          <div className="hp-bidpanel-num">
            <span className="hp-bidpanel-num-label">{t('stage.currentBid')}</span>
            <span className="hp-bidpanel-num-value">{usd(lot.highBid)}</span>
          </div>
          <div className="hp-bidpanel-num hp-bidpanel-num--yours">
            <span className="hp-bidpanel-num-label">{t('bidPanel.yourBid')}</span>
            <span className="hp-bidpanel-num-value" data-testid="bid-amount">{usd(nextAmount.toString())}</span>
          </div>
          <div className="hp-bidpanel-num">
            <span className="hp-bidpanel-num-label">{t('bidPanel.limitLabel')}</span>
            <span className="hp-bidpanel-num-value">{positiveAmount(lot.reserve) == null ? t('bidPanel.noLimitValue') : usd(lot.reserve)}</span>
          </div>
        </div>

        <p className={`hp-bidpanel-standing${standing.clearsReserve ? ' is-clear' : ' is-below'}`}>{standingText}</p>

        {balance && (
          <p className={`hp-bidpanel-balance${low ? ' is-low' : ''}`} data-testid="bid-balance">
            {balance.usdc != null ? t('bid.balance', { amount: usd(balance.usdc) }) : t('bid.balanceUnknown')}
            {low && <> {t('bid.balanceLow')}</>}
            {faucetAtBalance && <> <FaucetButton onDone={onFunded} /></>}
            {(low || devnet) && !faucetAtBalance && !faucetAtError && <> <Link href={`/${locale}/account#funds`} className="hp-inline-link">{t('bid.getTestUsdc')}</Link></>}
          </p>
        )}

        <p className="hp-bidpanel-ifwin" data-testid="bid-if-win">{t('bidPanel.ifYouWin', { amount: usd(nextAmount.toString()) })}</p>
        {!practice && <p className="hp-bidpanel-binding">{t('bidPanel.binding', { amount: usd(nextAmount.toString()) })}</p>}

        <details className="hp-bidpanel-details">
          <summary data-testid="bid-details-toggle">{t('bidPanel.details')}</summary>
          <FeeBreakdown amountBaseUnits={nextAmount.toString()} solUsd={solUsd} devnet={devnet} />
          <p className="hp-bidpanel-outcome">{t('bidPanel.outcome')}</p>
        </details>
        {practice && <p className="hp-bidpanel-demo">{t('bidPanel.demoNote')}</p>}
        {error && <p className="hp-bidpanel-error" role="alert" data-testid="bid-error">{error}{faucetAtError && <> <FaucetButton onDone={onFunded} /></>}</p>}

        <div className="hp-bidpanel-cta">
          <button type="button" disabled={pending} onClick={onConfirm} data-testid="bid-confirm">
            {pending ? t('bid.placing') : practice ? t('bid.bid') : t('bid.bindingLabel')}
          </button>
        </div>
      </div>
    </>
  );
}
