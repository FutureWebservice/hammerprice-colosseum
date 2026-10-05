'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { prefillAmount } from './prefill';
import { useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import type { RoomLot, RoomPhase, VisitorInfo } from './types';
import type { BidGate } from './model';
import Announcer from './Announcer';
import BidPanel from './BidPanel';
import { quickBidsOf } from './model';

export type { RoomPhase, VisitorInfo, VisitorStatus } from './types';

/**
 * The big brass slab and the viewer's standing. One path in: the Get ready sheet (connect, verify, test funds, bidding
 * number), then bid through a confirmation step. `gate` (model.ts bidGate) says which of those the slab does right now.
 */
export default function BidControl({
  lot, gate, busy, nextAmount, visitor, phase, msToNext = null, paddleNumber, practice, pending, pendingServer, error, fundsShort = false, balance, devnet, locale,
  solUsd = null, prefill = null, onGate, onConfirm, onHold, onPrefillShown, onDismissError, onFunded,
}: {
  lot: RoomLot | null;
  gate: BidGate;
  /** A wallet connect, sign-in or paddle registration is in progress. */
  busy: boolean;
  /** Next legal bid, in USDC base units, or null if no lot is open. */
  nextAmount: bigint | null;
  visitor: VisitorInfo;
  phase: RoomPhase;
  msToNext?: number | null;
  paddleNumber: number | null;
  practice: boolean;
  /** The bid request is in flight. */
  pending: boolean;
  /** The bid was accepted optimistically and the room has not confirmed it yet. */
  pendingServer: boolean;
  /** An already translated bid error, or null. */
  error: string | null;
  /** `error` is the server's "your USDC does not cover this bid" (code insufficient_funds). */
  fundsShort?: boolean;
  balance: { usdc: string | null } | null;
  devnet: boolean;
  locale: string;
  solUsd?: number | null;
  /** The slab at a gate (connect, sign in, register) opens the one Get ready sheet. */
  onGate: (g: 'connect' | 'sign_in' | 'register') => void;
  /** A room link named an amount for this lot (a Telegram lot alert): the confirmation opens at once, as soon as bidding is possible, with that amount filled in. Never a bid by itself. */
  prefill?: { amount: bigint } | null;
  /** The confirmation for `prefill` is showing: the room forgets the link. */
  onPrefillShown?: () => void;
  /** Resolves true when the bid was accepted (the panel then closes). Gets the amount the panel shows, which is what the person confirmed. */
  onConfirm: (amount: bigint) => Promise<boolean>;
  /** Practice room only: holds the simulated clock while the panel is open. */
  onHold?: (held: boolean) => void;
  onDismissError: () => void;
  /** Devnet: test USDC was claimed from the panel; the room re-reads the balance. The error is dropped here. */
  onFunded?: () => void;
}) {
  const t = useTranslations('room');
  const usd = useUsd();
  const isOpen = !!lot && lot.state === 'open';
  const isLeading = visitor.status === 'leading';
  const inGap = phase === 'gap' && msToNext != null;
  const paused = gate === 'paused';
  const canOpenPanel = gate === 'ready' && nextAmount !== null && !pending;
  const pressable = !busy && (canOpenPanel || gate === 'connect' || gate === 'sign_in' || gate === 'register');

  // The confirmation can start open with the amount from a room link. The amount only ever raises what the panel shows: the live next bid is the floor.
  const first = prefill && canOpenPanel && nextAmount !== null ? prefillAmount(prefill, nextAmount) : null;
  const [panelOpen, setPanelOpen] = useState(first !== null);
  const [linkAmount, setLinkAmount] = useState<{ amount: bigint; used: boolean } | null>(first);
  const [quickPick, setQuickPick] = useState(false); // the amount was chosen with a quick raise chip, not taken from a room link
  const slabRef = useRef<HTMLButtonElement>(null);
  const shown = nextAmount !== null && linkAmount && linkAmount.amount > nextAmount ? linkAmount.amount : nextAmount;

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setLinkAmount(null);
    setQuickPick(false);
    onDismissError();
    requestAnimationFrame(() => slabRef.current?.focus());
  }, [onDismissError]);

  // A real lot's hammer waits for no dialog: if the lot the panel was opened for stops being biddable, close it.
  useEffect(() => {
    if (panelOpen && !canOpenPanel && !pending) closePanel();
  }, [panelOpen, canOpenPanel, pending, closePanel]);

  // Practice room: hold the simulated clock while a reader looks at the numbers.
  useEffect(() => {
    if (!onHold) return undefined;
    onHold(panelOpen);
    return () => onHold(false);
  }, [panelOpen, onHold]);

  useEffect(() => {
    if (!prefill || !canOpenPanel || nextAmount === null) return;
    if (!panelOpen) { setLinkAmount(prefillAmount(prefill, nextAmount)); setPanelOpen(true); }
    onPrefillShown?.();
  }, [prefill, canOpenPanel, nextAmount, panelOpen, onPrefillShown]);

  const funded = useCallback(() => { onFunded?.(); onDismissError(); }, [onFunded, onDismissError]);

  const confirm = useCallback(async () => {
    if (shown !== null && (await onConfirm(shown))) closePanel();
  }, [onConfirm, closePanel, shown]);

  const label = inGap
    ? t('bid.nextLotIn', { seconds: Math.max(0, Math.ceil(msToNext! / 1000)) })
    : paused ? t('bid.pausedSlab')
    : gate === 'leading' ? t('bid.leadingSlab')
    : !lot ? t('bid.noLotOpen')
    : lot.state === 'catalogued' ? t('bid.notOpenYet')
    : lot.state === 'sold' ? t('state.sold')
    : lot.state === 'passed' ? t('state.passed')
    : lot.state === 'withdrawn' ? t('state.withdrawn')
    : busy ? t('bid.signingIn')
    : gate === 'connect' || gate === 'sign_in' || gate === 'register' ? t('bid.getReady')
    : pending ? t('bid.placing')
    : t('bid.bid');

  // The slab pulses once per change in the viewer's standing: keying it on the fact replays the animation once.
  const pulseKey = `${lot?.id ?? ''}-${visitor.status}-${visitor.outbidBy?.amount ?? ''}`;

  return (
    <section className="ar-bidbar-wrap" id="ar-bidding" aria-label={t('a11y.bidding')} data-tour="bid">
      <Announcer lot={lot} visitor={visitor} phase={phase} />
      <div className="ar-paddle" aria-live="polite">
        {visitor.status === 'leading' && visitor.lastAmount != null ? (
          <span className="ar-paddle-status is-leading">
            <span className="ar-paddle-dot" />
            {t('bid.leadingLine', { amount: usd(visitor.lastAmount.toString()) })}
          </span>
        ) : visitor.status === 'outbid' && visitor.outbidBy ? (
          <span className="ar-paddle-status is-outbid" data-testid="outbid-status">
            {t('bid.outbidLine', { paddle: visitor.outbidBy.paddle, amount: usd(visitor.outbidBy.amount.toString()) })}
          </span>
        ) : visitor.status === 'won' && visitor.hammer ? (
          <span className="ar-paddle-status is-won">{t('bid.wonLine', { amount: usd(visitor.hammer.amount.toString()) })}</span>
        ) : visitor.status === 'lost' && visitor.hammer ? (
          <span className="ar-paddle-status is-lost">
            {t('bid.lostLine', { paddle: lot?.highBidder ?? t('feed.bidderFallback'), amount: usd(visitor.hammer.amount.toString()) })}
          </span>
        ) : paddleNumber != null ? (
          <>{t('bid.yourPaddle', { number: paddleNumber })}</>
        ) : (
          /* the viewer's own state (no bidder number yet), never the state of the room: the room's live or scheduled chip is separate */
          <span data-testid="bid-no-paddle">{t(isOpen ? 'bid.noPaddleOpen' : 'bid.noPaddleSoon')}</span>
        )}
        {pendingServer && <span className="ar-paddle-pending">{t('bid.pendingServer')}</span>}
        {balance && balance.usdc != null && !panelOpen && <span className="ar-paddle-funds" data-testid="funds-line">{t('bid.balance', { amount: usd(balance.usdc) })}</span>}
      </div>
      <button
        key={pulseKey}
        ref={slabRef}
        type="button"
        className={`ar-bidbtn${isOpen && !isLeading && !paused ? '' : ' is-dormant'}${visitor.status === 'outbid' ? ' is-pulse' : ''}`}
        disabled={!pressable}
        aria-haspopup={gate === 'ready' ? 'dialog' : undefined}
        aria-expanded={gate === 'ready' ? panelOpen : undefined}
        data-testid="bid-button"
        data-gate={gate}
        onClick={() => {
          if (gate === 'ready') setPanelOpen(true);
          else if (gate === 'connect' || gate === 'sign_in' || gate === 'register') onGate(gate);
        }}
      >
        <span className="ar-bidbtn-label">{label}</span>
        {gate === 'ready' && !inGap && nextAmount !== null && (
          <span className="ar-bidbtn-next">
            <span className="ar-bidbtn-next-label">{t('bid.nextAmount')}</span>
            <span className="ar-bidbtn-amount">{usd(nextAmount.toString())}</span>
          </span>
        )}
      </button>
      {gate === 'ready' && !inGap && isOpen && !pending && !panelOpen && nextAmount !== null && lot && (
        <div className="ar-quick" role="group" aria-label={t('bid.quickLabel')} data-testid="quick-bids">
          <span className="ar-quick-label" aria-hidden="true">{t('bid.quickLabel')}</span>
          {quickBidsOf(lot, nextAmount).map((a) => (
            <button key={a.toString()} type="button" className="hpx-btn hpx-btn--ghost ar-quick-btn" data-testid="quick-bid" onClick={() => { setLinkAmount({ amount: a, used: false }); setQuickPick(true); setPanelOpen(true); }}>
              {usd(a.toString())}
            </button>
          ))}
        </div>
      )}
      {error && !panelOpen && <div className="ar-bid-error" role="alert">{error}</div>}
      {panelOpen && lot && nextAmount !== null && shown !== null && (
        <BidPanel
          lot={lot}
          nextAmount={shown}
          fromLink={linkAmount && !quickPick ? (linkAmount.used ? 'used' : 'adjusted') : null}
          pending={pending}
          error={error}
          fundsShort={fundsShort}
          practice={practice}
          balance={balance}
          devnet={devnet}
          locale={locale}
          solUsd={solUsd}
          onFunded={funded}
          onConfirm={confirm}
          onClose={closePanel}
        />
      )}
    </section>
  );
}
