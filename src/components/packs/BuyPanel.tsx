'use client';

/**
 * The buy panel of one pack: the gates in order (pack on sale, not your own, wallet connected, signed in, 18+ confirmed), then the purchase
 * itself with its honest status line, the decoded "what you sign" box while the wallet is open, and the reveal when the card arrived.
 * A chance pack is PAY FIRST: the buyer pays, the screen follows (confirming, drawing, delivering), and only a delivered card is revealed;
 * if it cannot be delivered the screen says the payment was returned.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import type { PackView } from '@/contracts';
import { useSession, useSignIn } from '@/components/auth/SessionProvider';
import SignInNotice from '@/components/auth/SignInNotice';
import ConnectWalletButton from '@/components/room/ConnectWalletButton';
import FaucetButton, { faucetAvailable } from '@/components/account/FaucetButton';
import { clientCluster } from '@/lib/client/cluster-text';
import { useNow } from '@/hooks/room/useNow';
import PayProgress from './PayProgress';
import OddsBar from './OddsBar';
import PackNotice from './PackNotice';
import Undelivered from './Undelivered';
import Revealed from './Revealed';
import { errorKey, secondsLeft, statusKey } from './purchase';
import { usd } from './format';
import { usePackPurchase } from './usePackPurchase';
import { usePackT } from './usePackT';

export default function BuyPanel({ pack, locale, onSettled, revealSlot, onReveal }: { pack: PackView; locale: 'de' | 'en'; onSettled?: () => void; revealSlot?: HTMLElement | null; onReveal?: (open: boolean) => void }) {
  const t = usePackT();
  const { connected } = useWallet();
  const { status, me } = useSession();
  const { signIn, pending } = useSignIn();
  const purchase = usePackPurchase(pack, { cluster: clientCluster() });
  const { state } = purchase;
  const [age, setAge] = useState(false);
  const now = useNow(500);
  const price = usd(pack.price, locale);
  const payFirst = pack.mode === 'chance';

  const settledId = state.kind === 'settled' ? state.draw.id : null;
  useEffect(() => { if (settledId) onSettled?.(); }, [settledId, onSettled]);
  const open = state.kind === 'settled' && !!revealSlot;
  useEffect(() => { onReveal?.(open); return () => onReveal?.(false); }, [open, onReveal]);

  if (state.kind === 'settled') {
    // The opening is one full-width stage: it is rendered into the slot at the top of the page when there is one (the panel itself then steps aside).
    const reveal = <Revealed draw={state.draw} pack={pack} locale={locale} onAnother={() => { setAge(false); purchase.reset(); }} onShown={purchase.markShown} />;
    return revealSlot ? createPortal(reveal, revealSlot) : <section aria-label={t('buy.title')} data-testid="buy-panel" data-state="settled">{reveal}</section>;
  }

  if (state.kind === 'undelivered') {
    return (
      <section className="pk-buy" aria-label={t('buy.title')} data-testid="buy-panel" data-state="undelivered">
        <Undelivered draw={state.draw} onBack={() => { purchase.markShown(state.draw.id); setAge(false); purchase.reset(); }} />
      </section>
    );
  }

  const isOperator = !!me && me.wallet === pack.operator.wallet;
  const closed = pack.status !== 'live';
  const busy = state.kind === 'working' || state.kind === 'wallet' || state.kind === 'waiting' || state.kind === 'following';
  const left = state.kind === 'wallet' ? secondsLeft(state.payment.roundExpiresAt, now ?? 0) : state.kind === 'waiting' ? secondsLeft(state.roundExpiresAt, now ?? 0) : null;
  const sk = statusKey(state);
  const by = state.kind === 'following' && state.draw.deliverBy ? new Date(state.draw.deliverBy).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '';
  const statusText = sk ? (left !== null && now !== null ? t(sk, { seconds: left, time: by }) : t(sk === 'step.wallet' ? 'step.walletNoClock' : sk, { seconds: 0, time: by })) : null;
  const review = state.kind === 'wallet' ? state.review : null;

  let gate: React.ReactNode = null;
  if (closed) gate = <p className="pk-status">{t(pack.status === 'paused' ? 'buy.paused' : pack.status === 'sold_out' ? 'buy.soldOut' : 'buy.notLive')}</p>;
  else if (isOperator) gate = <p className="pk-status">{t('buy.operatorSelf')}</p>;
  else if (!connected) gate = <div data-testid="buy-connect"><ConnectWalletButton /></div>;
  else if (status !== 'signed-in') {
    gate = (
      <>
        <button type="button" className="hpx-btn" disabled={pending} onClick={() => void signIn()} data-testid="buy-signin">{pending ? t('buy.signingIn') : t('buy.signIn')}</button>
        <SignInNotice />
      </>
    );
  }

  return (
    <section className="pk-buy" aria-label={t('buy.title')} data-testid="buy-panel" data-state={state.kind}>
      <div className="pk-buy-price" data-testid="pack-price">{price}</div>
      <OddsBar odds={pack.odds} locale={locale} compact />
      {gate ?? (
        <>
          <label className="pk-check">
            <input type="checkbox" checked={age} disabled={busy} onChange={(e) => setAge(e.target.checked)} data-testid="age-check" />
            <span>{t('buy.age')}</span>
          </label>
          <button
            type="button" className="hpx-btn" data-testid="buy-button"
            disabled={!age || busy}
            onClick={() => void purchase.start()}
          >
            {state.kind === 'lapsed' ? t('step.again') : t(payFirst ? 'buy.buttonPay' : 'buy.button', { price })}
          </button>
        </>
      )}
      <PackNotice pack={pack} />
      <div className="pk-status" role="status" aria-live="polite" data-testid="buy-status">
        {statusText}
        {state.kind === 'ended' && <span className="pk-status--error">{t(`errors.${state.reason}`)}</span>}
        {state.kind === 'error' && <span className="pk-status--error" data-testid="buy-error" data-code={state.code}>{t(`errors.${errorKey(state.code, { wallet: state.wallet, retryAfterS: state.retryAfterS })}`)}</span>}
      </div>
      {state.kind === 'error' && state.code === 'insufficient_usdc' && faucetAvailable() && <FaucetButton onDone={purchase.reset} />}
      {state.kind === 'following' && <PayProgress draw={state.draw} />}
      {review && (
        <dl className="pk-review" data-testid="sign-review">
          <div><dt>{t('step.youPay')}</dt><dd>{usd(review.gross.toString(), locale)}</dd></div>
          <div><dt>{t(payFirst && pack.operator.isHouse ? 'step.toHouse' : 'step.toOperator')}</dt><dd>{usd(review.toSeller.toString(), locale)}</dd></div>
          <div><dt>{t('step.fee')}</dt><dd>{usd(review.toFeeWallet.toString(), locale)}</dd></div>
          <div><dt>{t('step.card')}</dt><dd>{payFirst ? t('step.cardNone') : '1'}</dd></div>
        </dl>
      )}
      {state.kind === 'wallet' && <p className="pk-note" style={{ margin: 0 }}>{t('step.gas')}</p>}
    </section>
  );
}
