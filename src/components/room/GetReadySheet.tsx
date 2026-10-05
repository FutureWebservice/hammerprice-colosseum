'use client';

/**
 * ONE sheet from "I want to bid" to a first bid, for a new visitor: 1 Connect wallet, 2 Verify wallet (a free signature,
 * no payment), 3 Test funds (devnet: claimed by itself when the wallet is empty, or with one button). When all three are
 * done one button remains: Start bidding, which signs the bidding number (the "paddle", PaddleAuthV1) with defaults.
 * The spending limit (the wallet's balance, at most 250) and the validity (3 hours) are editable under Advanced options.
 * The sheet only draws; AuctionRoom owns sign-in and the paddle, this owns the faucet call.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useDialog } from '@/hooks/room/useDialog';
import { useUsd } from '@/hooks/room/useUsd';
import { DEFAULT_PADDLE_HOURS, defaultSpendingLimit, parseUsdc, readyStep } from '@/lib/client/bidder';
import { claimFaucet } from '@/components/account/api';
import WalletPromptHint from '@/components/explain/WalletPromptHint';
import type { MeStatus } from '@/hooks/room/useMe';
import { WalletPicker } from './WalletSheet';
import { afterPick } from './walletConnect';
import { isMobileUa } from './wallets';
import './room.css';

const HOURS = [1, 3, 6] as const;
type Faucet = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done' } | { kind: 'fail'; code: string };

export default function GetReadySheet({
  wallet, meStatus, usdc, devnet, signInBusy, signInError, paddleBusy, paddleError, onVerify, onRefresh, onStart, onClose,
}: {
  wallet: string | null;
  meStatus: MeStatus;
  /** The wallet's USDC balance in base units from /api/me, null when unreadable. */
  usdc: string | null;
  devnet: boolean;
  signInBusy: boolean;
  /** Already translated error sentences, or null. */
  signInError: string | null;
  paddleBusy: boolean;
  paddleError: string | null;
  onVerify: () => void;
  /** Re-reads /api/me (after the faucet, or for "Check again"). */
  onRefresh: () => void;
  onStart: (o: { maxBid: bigint; hours: number }) => void;
  onClose: () => void;
}) {
  const t = useTranslations('room');
  const tt = useTranslations('tour');
  const locale = useLocale();
  const usd = useUsd();
  const ref = useDialog<HTMLDivElement>(onClose);
  const step = readyStep({ wallet, me: meStatus, usdc });
  const cluster = devnet ? 'devnet' : 'mainnet-beta';
  const [faucet, setFaucet] = useState<Faucet>({ kind: 'idle' });
  const [max, setMax] = useState<string | null>(null); // null: the default
  const [hours, setHours] = useState<number>(DEFAULT_PADDLE_HOURS);

  const claim = useCallback(async () => {
    setFaucet({ kind: 'busy' });
    const r = await claimFaucet();
    if (r.ok) { setFaucet({ kind: 'done' }); onRefresh(); } else setFaucet({ kind: 'fail', code: r.code });
  }, [onRefresh]);

  // The wallet the person clicked in step 1 is connected and has no session: go on into the signature (step 2's button, pressed for them; a phone keeps the tap).
  const picked = useRef(false);
  useEffect(() => {
    const next = afterPick({ wanted: picked.current, looked: wallet !== null && (meStatus === 'signed_out' || meStatus === 'ready'), anonymous: meStatus === 'signed_out', mobile: isMobileUa(navigator.userAgent) });
    if (next === 'wait') return;
    picked.current = false;
    if (next === 'sign') onVerify();
  }, [wallet, meStatus, onVerify]);

  const fallback = defaultSpendingLimit(usdc);
  const typed = max === null || max.trim() === '' ? null : parseUsdc(max);
  const invalid = max !== null && max.trim() !== '' && typed === null;
  const limit = typed ?? fallback;

  const names = ['connect', 'verify', 'funds'] as const;
  const shown = Math.min(step, 3);

  return (
    <>
      <div className="hp-sheet-backdrop" onClick={onClose} />
      <div className="hp-sheet" ref={ref} role="dialog" aria-modal="true" aria-label={t('ready.title')} data-testid="ready-sheet" data-step={step}>
        <div className="hp-sheet-head">
          <h2 className="hp-sheet-title">{t('ready.title')}</h2>
          <button type="button" className="hp-sheet-close" onClick={onClose} aria-label={t('wallet.close')}>×</button>
        </div>

        <ol className="hp-ready-steps" aria-label={t('ready.progress', { step: shown })}>
          {names.map((n, i) => {
            const state = step > i + 1 ? 'done' : step === i + 1 ? 'now' : 'next';
            return (
              <li key={n} className={`hp-ready-step is-${state}`} aria-current={state === 'now' ? 'step' : undefined} data-testid={`ready-step-${n}`} data-state={state}>
                <span className="hp-ready-dot" aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
                <span>{t(`ready.steps.${n}`)}</span>
              </li>
            );
          })}
        </ol>

        {step === 1 && (
          <>
            <p className="hp-sheet-text">{t('ready.connect.body')}</p>
            <WalletPicker withNeeds={false} onPick={() => { picked.current = true; }} />
            <p className="hp-sheet-text" data-testid="ready-no-wallet">
              {t('ready.connect.watch')}{' '}
              <a className="hp-inline-link" href={`/${locale}/about#wallet`}>{tt('help.wallet')}</a>
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <p className="hp-sheet-text">{t('ready.verify.body')}</p>
            <WalletPromptHint kind="signin" cluster={cluster} />
            {signInError && <p className="hp-sheet-error" role="alert">{signInError}</p>}
            <div className="hp-sheet-actions">
              <button type="button" className="hp-sheet-primary is-big" data-testid="ready-verify" disabled={signInBusy || meStatus === 'loading'} onClick={onVerify}>
                {signInBusy || meStatus === 'loading' ? t('ready.waiting') : t('ready.verify.button')}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p className="hp-sheet-text">{devnet ? t('ready.funds.bodyDevnet') : t('ready.funds.bodyMain')}</p>
            <p className="hp-ready-balance" data-testid="ready-balance">{t('ready.funds.balance', { amount: usdc != null ? usd(usdc) : t('ready.funds.unknown') })}</p>
            {faucet.kind === 'busy' && <p className="hp-sheet-text" role="status">{t('ready.funds.claiming')}</p>}
            {faucet.kind === 'fail' && <p className="hp-sheet-error" role="alert" data-testid="ready-funds-error">{t(faucet.code === 'rate_limited' ? 'ready.funds.limited' : faucet.code === 'faucet_paused' ? 'ready.funds.paused' : 'ready.funds.failed')}</p>}
            <div className="hp-sheet-actions">
              {devnet ? (
                <button type="button" className="hp-sheet-primary is-big" data-testid="ready-claim" disabled={faucet.kind === 'busy'} onClick={() => void claim()}>
                  {faucet.kind === 'busy' ? t('ready.waiting') : t('ready.funds.claim')}
                </button>
              ) : (
                <button type="button" className="hp-sheet-primary is-big" data-testid="ready-recheck" onClick={onRefresh}>{t('ready.funds.recheck')}</button>
              )}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <p className="hp-sheet-text">{t('ready.start.body')}</p>
            <details className="hp-ready-advanced">
              <summary>{t('ready.advanced.summary')}</summary>
              <label className="hp-field">
                <span>{t('ready.advanced.limitLabel')}</span>
                <input inputMode="decimal" value={max ?? ''} onChange={(e) => setMax(e.target.value)} aria-invalid={invalid} aria-describedby="hp-ready-max-help" placeholder={String(Number(fallback) / 1e6)} />
              </label>
              <p id="hp-ready-max-help" className={`hp-field-help${invalid ? ' is-error' : ''}`}>{invalid ? t('paddle.maxInvalid') : t('ready.advanced.limitHelp', { amount: usd(fallback.toString()) })}</p>
              <label className="hp-field">
                <span>{t('paddle.expiryLabel')}</span>
                <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {HOURS.map((h) => <option key={h} value={h}>{t('paddle.hours', { hours: h })}</option>)}
                </select>
              </label>
            </details>
            {paddleError && <p className="hp-sheet-error" role="alert">{paddleError}</p>}
            <WalletPromptHint kind="paddle" cluster={cluster} />
            <div className="hp-sheet-actions">
              <button type="button" className="hp-sheet-primary is-big" data-testid="ready-start" disabled={paddleBusy || invalid} onClick={() => onStart({ maxBid: limit, hours })}>
                {paddleBusy ? t('ready.waiting') : t('ready.start.button')}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
