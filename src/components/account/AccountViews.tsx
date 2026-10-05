'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import type { SettlementView } from '@/contracts/chain';
import type { MeResponse } from '@/contracts/api';
import { addressUrl, shortAddress, txUrl } from '@/components/sell/chain-links';
import { countdown, formatWhen } from '@/components/sell/datetime';
import { formatUsdc } from '@/components/sell/money';
import type { ActivityItems, Paged, PaddleRow, PaddlesState } from './useAccountData';
import { hasSellerRole, settlementHref, sortByDue, type PendingSettlement } from './desk';

/** Loading, error, empty and "load more" wrapped around a paged list. */
export function PagedList<I>({
  state, onRetry, onMore, empty, children,
}: { state: Paged<I>; onRetry: () => void; onMore: () => void; empty: string; children: (items: I[]) => React.ReactNode }) {
  const t = useTranslations('account');
  if (state.status === 'loading') return <p className="sl-note" role="status" data-testid="tab-loading">{t('loading')}</p>;
  if (state.status === 'error') {
    return (
      <div className="sl-warn" role="alert" data-testid="tab-error">
        <p>{t('loadError')}</p>
        <button type="button" className="sl-btn" onClick={onRetry}>{t('retry')}</button>
      </div>
    );
  }
  if (state.items.length === 0) return <p className="sl-lede" data-testid="tab-empty">{empty}</p>;
  return (
    <>
      {children(state.items)}
      {state.moreError && <p className="sl-warn" role="alert">{t('loadError')}</p>}
      {state.nextCursor && (
        <button type="button" className="sl-btn" data-testid="load-more" disabled={state.more} onClick={onMore}>
          {state.more ? t('loading') : t('loadMore')}
        </button>
      )}
    </>
  );
}

/** `pending` (from /api/me) knows the show of each open sale, so "Pay now" can open the signing screen in its room. */
export function WinsList({ items, receipts = {}, pending = [] }: { items: ActivityItems<'wins'>; receipts?: Record<string, SettlementView>; pending?: PendingSettlement[] }) {
  const t = useTranslations('account');
  const locale = useLocale();
  return (
    <ul className="sl-rows" data-testid="wins-list">
      {items.map((w) => {
        const receipt = receipts[w.settlementId];
        const open = w.status === 'awaiting_payment' || w.status === 'awaiting_seller';
        return (
          <li key={w.settlementId} className="sl-row" data-testid="win-row" data-status={w.status}>
            <div>
              <strong>{w.lotName}</strong>
              <p className="sl-note" data-testid="win-status">{t(`status.${w.status}`)}</p>
            </div>
            <div className="sl-right">
              <span className="hp-num">{formatUsdc(w.gross, locale)}</span>
              {(receipt?.txSignature || w.explorerUrl) && (
                <a href={receipt?.explorerUrl ?? (receipt?.txSignature ? txUrl(receipt.txSignature) : w.explorerUrl!)} target="_blank" rel="noopener noreferrer" data-testid="win-receipt">{t('wins.receipt')}</a>
              )}
              {open && <Link href={settlementHref(pending.find((p) => p.settlementId === w.settlementId) ?? ({ settlementId: w.settlementId, lotId: w.lotId } as PendingSettlement))} className="sl-btn sl-btn--primary" data-testid="win-sign">{t('wins.sign')}</Link>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ConsignmentsList({ items }: { items: ActivityItems<'consignments'> }) {
  const t = useTranslations('account');
  return (
    <ul className="sl-rows" data-testid="consignments-list">
      {items.map((c) => (
        <li key={c.lotId} className="sl-row" data-testid="consignment-row">
          <div>
            <strong>{c.lotName}</strong>
            <p className="sl-note"><a href={addressUrl(c.mint)} target="_blank" rel="noopener noreferrer">{shortAddress(c.mint)}</a></p>
          </div>
          <div className="sl-right">
            <span className="sl-tag sl-tag--dim">{t(`lotState.${c.state}`)}</span>
            <span className={`sl-badge sl-badge--${c.consign === 'ready' ? 'ready' : c.consign === 'rejected' ? 'blocked' : 'unchecked'}`}>{t(`consign.${c.consign}`)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One short notice above the tabs while anything waits for you. `onOpen` jumps to the To do tab. */
export function DeskBanner({ pending, onOpen }: { pending: PendingSettlement[]; onOpen?: () => void }) {
  const t = useTranslations('account');
  if (pending.length === 0) return null;
  return (
    <div className="sl-banner sl-banner--alert" role="status" data-testid="desk-banner">
      <strong>{t('desk.bannerTitle', { count: pending.length })}</strong>
      <p>{t('desk.bannerBody')}</p>
      {hasSellerRole(pending) && <p>{t('desk.bannerSeller')}</p>}
      {onOpen && <div className="sl-actions"><button type="button" className="sl-btn sl-btn--primary" data-testid="banner-open" onClick={onOpen}>{t('desk.bannerOpen')}</button></div>}
    </div>
  );
}

function Signed({ done, label }: { done: boolean; label: string }) {
  return <span className={`sl-badge sl-badge--${done ? 'ready' : 'unchecked'}`}>{label}</span>;
}

/** What this person has to do, in one sentence: "You won Charizard for 120.00 USDC. Pay now so the card moves to your wallet." */
export function DeskList({ pending, views, nowMs, names = {} }: { pending: PendingSettlement[]; views: Record<string, SettlementView>; nowMs: number; names?: Record<string, string> }) {
  const t = useTranslations('account');
  const locale = useLocale();
  if (pending.length === 0) return <p className="sl-lede" data-testid="desk-empty">{t('desk.empty')}</p>;
  return (
    <ul className="sl-rows" data-testid="desk-list">
      {sortByDue(pending).map((p) => {
        const v = views[p.settlementId];
        const left = countdown(p.dueAt, nowMs);
        const round = v?.roundExpiresAt ? countdown(v.roundExpiresAt, nowMs) : null;
        const card = names[p.lotId] ?? t('desk.aCard');
        const amount = formatUsdc(p.gross, locale);
        const mine = p.role === 'seller' ? v?.sellerSigned : v?.buyerSigned;
        const theirs = p.role === 'seller' ? v?.buyerSigned : v?.sellerSigned;
        return (
          <li key={p.settlementId} className="sl-row sl-row--col" data-testid="sign-request" data-role={p.role} data-status={p.status}>
            <div className="sl-row-top">
              <div>
                <strong>{p.role === 'seller' ? t('desk.sellerLine', { card, amount }) : t('desk.buyerLine', { card, amount })}</strong>
                <p className="sl-note" data-testid="window-left">{left ? t('desk.windowLeft', { time: left }) : t('desk.windowOver')}</p>
                {v && mine && <p className="sl-note" data-testid="my-part-done">{t('desk.waitingOther')}</p>}
                {v && !mine && theirs && <p className="sl-note" data-testid="other-part-done">{t('desk.otherReady')}</p>}
              </div>
              <Link href={settlementHref(p)} className="sl-btn sl-btn--primary" data-testid="sign-link">
                {p.role === 'seller' ? t('desk.openSeller') : t('desk.openBuyer')}
              </Link>
            </div>
            {v && (
              <details className="sl-more" data-testid="desk-details">
                <summary>{t('desk.details')}</summary>
                <p className="sl-note" data-testid="round-state">
                  <Signed done={v.buyerSigned} label={v.buyerSigned ? t('desk.buyerSigned') : t('desk.buyerWaiting')} />{' '}
                  <Signed done={v.sellerSigned} label={v.sellerSigned ? t('desk.sellerSigned') : t('desk.sellerWaiting')} />{' '}
                  {round ? t('desk.roundOpen', { time: round }) : t('desk.roundClosed')}
                </p>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PaddlesList({ state, onRelease, onRetry }: { state: PaddlesState; onRelease: (row: PaddleRow) => void; onRetry: () => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  if (state.status === 'loading') return <p className="sl-note" role="status">{t('loading')}</p>;
  if (state.status === 'error') {
    return (
      <div className="sl-warn" role="alert" data-testid="tab-error">
        <p>{t('loadError')}</p>
        <button type="button" className="sl-btn" onClick={onRetry}>{t('retry')}</button>
      </div>
    );
  }
  if (state.rows.length === 0) return <p className="sl-lede" data-testid="tab-empty">{t('paddles.empty')}</p>;
  return (
    <ul className="sl-rows" data-testid="paddles-list">
      {state.rows.map((r) => (
        <li key={r.show.id} className="sl-row" data-testid="paddle-row">
          <div>
            <strong><Link href={`/room/${r.show.id}`}>{r.show.title}</Link></strong>
            <p className="sl-note">{t('paddles.until', { when: formatWhen(r.validUntil, locale) })} · {r.funded ? t('paddles.funded') : t('paddles.unfunded')}</p>
          </div>
          <div className="sl-right">
            <span className="sl-paddle" data-testid="paddle-number">{r.number}</span>
            <button type="button" className="sl-btn" data-testid="release-paddle" onClick={() => onRelease(r)}>{t('paddles.release')}</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export type FaucetUi =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; amount: string; signature: string }
  | { kind: 'fail'; code: string; wait?: string };

/** Test funds: the balance, the faucet button and the plain-language explanation of test USDC. */
export function FundsPanel({
  devnet, funds, ui, onClaim,
}: { devnet: boolean; funds: MeResponse['funds']; ui: FaucetUi; onClaim: () => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  if (!devnet) return <p className="sl-lede" data-testid="funds-mainnet">{t('funds.notDevnet')}</p>;
  return (
    <div data-testid="funds-panel">
      <p className="sl-lede">{t('funds.explain')}</p>
      <p className="sl-note">{t('funds.noSol')}</p>
      <p className="sl-balance" data-testid="funds-balance">
        <span className="hp-label">{t('funds.balance')}</span>
        <span className="hp-num">{funds.usdc === null ? t('funds.unavailable') : formatUsdc(funds.usdc, locale)}</span>
      </p>
      <button type="button" className="sl-btn sl-btn--primary" data-testid="faucet-button" disabled={ui.kind === 'busy'} onClick={onClaim}>
        {ui.kind === 'busy' ? t('funds.busy') : t('funds.claim')}
      </button>
      <p className="sl-note">{t('funds.limits')}</p>
      <div role="status" aria-live="polite">
        {ui.kind === 'done' && (
          <p className="sl-ok" data-testid="faucet-done">
            {t('funds.done', { amount: formatUsdc(ui.amount, locale) })}{' '}
            <a href={txUrl(ui.signature)} target="_blank" rel="noopener noreferrer">{t('funds.receipt')}</a>
          </p>
        )}
        {ui.kind === 'fail' && (
          <p className="sl-warn" data-testid="faucet-error" data-code={ui.code}>
            {ui.code === 'rate_limited' ? t('funds.rateLimited', { wait: ui.wait ?? t('funds.later') }) : ui.code === 'faucet_paused' ? t('funds.paused') : ui.code === 'not_found' ? t('funds.notHere') : t('funds.failed')}
          </p>
        )}
      </div>
    </div>
  );
}
