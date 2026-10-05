'use client';

/**
 * The sections of the profile page that show what the account owns, bid on, bought and sold. Every component here is pure (props in, markup out),
 * so each loading, error, empty and filled state renders in a test without a network. The containers that load the data live in Account.tsx.
 */
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import type { RouteResponse, ShowSummary } from '@/contracts/api';
import type { SellAsset } from '@/contracts/api';
import type { SummaryResponse, WalletResponse } from '@/contracts/profile';
import { formatWhen } from '@/components/sell/datetime';
import { formatUsdc } from '@/components/sell/money';
import type { AssetsState } from '@/components/sell/useAssets';
import { formatSol } from './format';
import type { ActivityItems } from './useAccountData';
import type { Load } from './useProfileData';

/** The same loading, error and retry shell for every section that reads one route. */
export function LoadShell<T>({ state, onRetry, children, error }: { state: Load<T>; onRetry?: () => void; children: (data: T) => React.ReactNode; error?: string }) {
  const t = useTranslations('account');
  if (state.status === 'loading') return <p className="sl-note" role="status" data-testid="section-loading">{t('loading')}</p>;
  if (state.status === 'error') {
    return (
      <div className="sl-warn" role="alert" data-testid="section-error">
        <p>{error ?? t('loadError')}</p>
        {onRetry && <button type="button" className="sl-btn" onClick={onRetry}>{t('retry')}</button>}
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

// ---- wallet -------------------------------------------------------------------------------------

export function WalletBalances({ wallet, available, onRetry }: { wallet: Load<WalletResponse>; available: string | null; onRetry?: () => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  return (
    <section aria-labelledby="wallet-heading" data-testid="wallet-balances">
      <h2 className="sl-h3" id="wallet-heading">{t('wallet.title')}</h2>
      <LoadShell state={wallet} onRetry={onRetry}>
        {(w) => (
          <>
            <p className="sl-note">{t('wallet.network', { cluster: w.cluster })}</p>
            <dl className="ac-stats">
              <div className="ac-stat"><dt>{t('wallet.sol')}</dt><dd className="hp-num" data-testid="balance-sol">{formatSol(w.sol, locale) ?? t('wallet.unavailable')}</dd></div>
              <div className="ac-stat"><dt>{t('wallet.usdc')}</dt><dd className="hp-num" data-testid="balance-usdc">{w.usdc === null ? t('wallet.unavailable') : formatUsdc(w.usdc, locale)}</dd></div>
              <div className="ac-stat">
                <dt>{t('wallet.available')}</dt>
                <dd className="hp-num" data-testid="balance-available">{available === null ? t('wallet.unavailable') : formatUsdc(available, locale)}</dd>
                <dd className="sl-hint">{t('wallet.availableHint')}</dd>
              </div>
            </dl>
          </>
        )}
      </LoadShell>
    </section>
  );
}

/** The cards the wallet holds (the sell reader, with its DAS fallback), each with a way into the sell wizard when it can be sold. */
export function CardsView({ state, onRetry }: { state: AssetsState; onRetry?: () => void }) {
  const t = useTranslations('account');
  const body: Load<SellAsset[]> = state.status === 'ready' ? { status: 'ready', data: state.assets } : state.status === 'error' ? { status: 'error', error: state.error } : { status: 'loading' };
  return (
    <section aria-labelledby="cards-heading" data-testid="wallet-cards">
      <h2 className="sl-h3" id="cards-heading">{t('wallet.cardsTitle')}</h2>
      <p className="sl-note">{t('wallet.cardsLede')}</p>
      <LoadShell state={body} onRetry={onRetry} error={t('wallet.cardsError')}>
        {(assets) => assets.length === 0 ? <p className="sl-lede" data-testid="cards-empty">{t('wallet.cardsEmpty')}</p> : (
          <ul className="sl-grid" data-testid="cards-grid">
            {assets.map((a) => (
              <li key={a.mint} className={`sl-card${a.eligible ? '' : ' sl-card--off'}`} data-testid="wallet-card" data-mint={a.mint} data-eligible={a.eligible}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
                {a.imageUrl ? <img className="sl-card-img" src={a.imageUrl} alt="" loading="lazy" decoding="async" /> : <div className="sl-card-img sl-card-img--empty" aria-hidden="true" />}
                <div className="sl-card-body">
                  <h3 className="sl-card-name">{a.name || t('wallet.unnamed')}</h3>
                  {a.grade && <p className="sl-card-meta"><span className="sl-tag">{a.grade}</span></p>}
                  {a.eligible
                    ? <Link href="/sell/new" className="sl-btn sl-btn--primary" data-testid="sell-card">{t('wallet.sell')}<span className="ac-sr"> ({a.name})</span></Link>
                    : <p className="sl-note" data-testid="card-not-sellable">{t('wallet.notSellable')}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </LoadShell>
    </section>
  );
}

// ---- bids ---------------------------------------------------------------------------------------

type BidItem = ActivityItems<'bids'>[number];

/** Active (the lot is still open) first, then the history. Each row says what became of the bid. */
export function BidSections({ items }: { items: BidItem[] }) {
  const t = useTranslations('account');
  const locale = useLocale();
  const active = items.filter((b) => b.lotState === 'open');
  const history = items.filter((b) => b.lotState !== 'open');
  const row = (b: BidItem) => (
    <li key={b.bidId} className="sl-row" data-testid="bid-row" data-result={b.result}>
      <div>
        <strong>{b.lotName}</strong>
        <p className="sl-note">{formatWhen(b.placedAt, locale)}</p>
      </div>
      <div className="sl-right">
        <span className="hp-num">{formatUsdc(b.amount, locale)}</span>
        <span className={`sl-badge sl-badge--${b.result === 'leading' || b.result === 'won' ? 'ready' : 'unchecked'}`}>{t(`bids.result.${b.result}`)}</span>
      </div>
    </li>
  );
  return (
    <>
      <h2 className="sl-h3">{t('bids.active')}</h2>
      {active.length === 0 ? <p className="sl-lede" data-testid="bids-no-active">{t('bids.noActive')}</p> : <ul className="sl-rows" data-testid="bids-active">{active.map(row)}</ul>}
      <h2 className="sl-h3">{t('bids.history')}</h2>
      {history.length === 0 ? <p className="sl-lede">{t('bids.empty')}</p> : <ul className="sl-rows" data-testid="bids-history">{history.map(row)}</ul>}
    </>
  );
}

// ---- sales --------------------------------------------------------------------------------------

const ORDER: ShowSummary['status'][] = ['live', 'scheduled', 'ended'];

/** The rooms of this account, live first, then upcoming, then ended; each with its manage link. */
export function RoomsList({ shows }: { shows: ShowSummary[] }) {
  const t = useTranslations('account');
  const locale = useLocale();
  if (shows.length === 0) return <p className="sl-lede" data-testid="rooms-empty">{t('sales.roomsEmpty')}</p>;
  const ranked = [...shows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  return (
    <ul className="sl-rows" data-testid="rooms-list">
      {ranked.map((s) => {
        const at = s.status === 'ended' ? s.endedAt : s.status === 'live' ? s.startedAt : s.scheduledAt;
        return (
          <li key={s.id} className="sl-row" data-testid="room-row" data-status={s.status}>
            <div>
              <strong>{s.title}</strong>
              <p className="sl-note">
                <span className="sl-tag sl-tag--dim">{t(`sales.${s.status}`)}</span>{' '}
                {at ? formatWhen(at, locale) : null}{at ? ' · ' : null}{t('sales.lots', { sold: s.soldCount, count: s.lotCount })}
                {s.soldCount > 0 ? ` · ${t('sales.hammer', { amount: formatUsdc(s.hammerTotal, locale) })}` : null}
              </p>
            </div>
            <div className="sl-right">
              <Link href={`/sell/${s.id}`} className="sl-btn sl-btn--primary" data-testid="room-manage">{t('sales.manage')}<span className="ac-sr"> ({s.title})</span></Link>
              <Link href={`/room/${s.id}`} className="sl-btn" data-testid="room-open">{t('sales.open')}<span className="ac-sr"> ({s.title})</span></Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Lots this account sold: hammer price, the fee, what was paid out, and the transaction. */
export function SoldLots({ summary, onRetry }: { summary: Load<SummaryResponse>; onRetry?: () => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  return (
    <LoadShell state={summary} onRetry={onRetry} error={t('prices.loadError')}>
      {(s) => s.recentSales.length === 0 ? <p className="sl-lede" data-testid="sold-empty">{t('sales.soldEmpty')}</p> : (
        <ul className="sl-rows" data-testid="sold-list">
          {s.recentSales.map((r) => (
            <li key={r.settlementId} className="sl-row" data-testid="sold-row">
              <div>
                <strong>{r.lotName}</strong>
                {r.settledAt && <p className="sl-note">{t('sales.settledOn', { when: formatWhen(r.settledAt, locale) })}</p>}
              </div>
              <dl className="ac-money">
                <div><dt>{t('sales.hammerPrice')}</dt><dd className="hp-num">{formatUsdc(r.gross, locale)}</dd></div>
                <div><dt>{t('sales.fee')}</dt><dd className="hp-num">{formatUsdc(r.fee, locale)}</dd></div>
                <div><dt>{t('sales.payout')}</dt><dd className="hp-num">{formatUsdc(r.payout, locale)}</dd></div>
              </dl>
              {r.explorerUrl && <a href={r.explorerUrl} target="_blank" rel="noopener noreferrer" data-testid="sold-tx">{t('sales.tx')}</a>}
            </li>
          ))}
        </ul>
      )}
    </LoadShell>
  );
}

// ---- prices -------------------------------------------------------------------------------------

export function PricesView({ summary, onRetry }: { summary: Load<SummaryResponse>; onRetry?: () => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  const usdc = (v: string | null) => (v === null ? t('prices.none') : formatUsdc(v, locale));
  return (
    <section aria-labelledby="prices-heading" data-testid="prices">
      <h2 className="sl-h3" id="prices-heading">{t('prices.title')}</h2>
      <p className="sl-note">{t('prices.note')}</p>
      <LoadShell state={summary} onRetry={onRetry} error={t('prices.loadError')}>
        {(s) => s.bought.count === 0 && s.sold.count === 0 ? <p className="sl-lede" data-testid="prices-empty">{t('prices.empty')}</p> : (
          <div className="ac-two">
            <div>
              <h3 className="sl-h3">{t('prices.bought')}</h3>
              <dl className="ac-stats" data-testid="prices-bought">
                <div className="ac-stat"><dt>{t('prices.bought')}</dt><dd className="hp-num">{t('prices.count', { count: s.bought.count })}</dd></div>
                <div className="ac-stat"><dt>{t('prices.total')}</dt><dd className="hp-num">{usdc(s.bought.count ? s.bought.totalGross : null)}</dd></div>
                <div className="ac-stat"><dt>{t('prices.average')}</dt><dd className="hp-num">{usdc(s.bought.averageGross)}</dd></div>
              </dl>
            </div>
            <div>
              <h3 className="sl-h3">{t('prices.soldTitle')}</h3>
              <dl className="ac-stats" data-testid="prices-sold">
                <div className="ac-stat"><dt>{t('prices.soldTitle')}</dt><dd className="hp-num">{t('prices.count', { count: s.sold.count })}</dd></div>
                <div className="ac-stat"><dt>{t('prices.total')}</dt><dd className="hp-num">{usdc(s.sold.count ? s.sold.totalGross : null)}</dd></div>
                <div className="ac-stat"><dt>{t('prices.average')}</dt><dd className="hp-num" data-testid="prices-average">{usdc(s.sold.averageGross)}</dd></div>
                <div className="ac-stat"><dt>{t('prices.best')}</dt><dd className="hp-num" data-testid="prices-best">{s.sold.best ? `${formatUsdc(s.sold.best.gross, locale)}` : t('prices.none')}</dd>{s.sold.best && <dd className="sl-hint">{s.sold.best.lotName}</dd>}</div>
                <div className="ac-stat"><dt>{t('prices.fees')}</dt><dd className="hp-num">{usdc(s.sold.count ? s.sold.totalFees : null)}</dd></div>
                <div className="ac-stat"><dt>{t('prices.payout')}</dt><dd className="hp-num">{usdc(s.sold.count ? s.sold.totalPayout : null)}</dd></div>
              </dl>
            </div>
          </div>
        )}
      </LoadShell>
    </section>
  );
}

// ---- credits ------------------------------------------------------------------------------------

export function CreditsView({ data }: { data: RouteResponse<'aiCredits'> }) {
  const t = useTranslations('account');
  const locale = useLocale();
  return (
    <section aria-labelledby="credits-heading" data-testid="credits">
      <h2 className="sl-h3" id="credits-heading">{t('credits.title')}</h2>
      <p className="sl-lede">{t('credits.lede')}</p>
      <dl className="ac-stats">
        <div className="ac-stat"><dt>{t('credits.balance')}</dt><dd className="hp-num" data-testid="credits-balance">{data.balance}</dd></div>
      </dl>
      <p className="sl-note">{t('credits.pack', { credits: data.pack.credits, price: formatUsdc(data.pack.priceUsdc, locale) })}</p>
      {data.packsLeftToday !== null && <p className="sl-note" data-testid="credits-left">{t('credits.packsLeft', { count: data.packsLeftToday })}</p>}
      <div className="sl-actions"><Link href="/sell/new" className="sl-btn sl-btn--primary" data-testid="credits-open">{t('credits.open')}</Link></div>
    </section>
  );
}

// ---- notifications and the danger zone ------------------------------------------------------------

export function NotificationsIntro({ onPayments }: { onPayments: () => void }) {
  const t = useTranslations('account');
  return (
    <section aria-labelledby="notif-heading" data-testid="notifications">
      <h2 className="sl-h3" id="notif-heading">{t('notifications.title')}</h2>
      <p className="sl-lede">{t('notifications.lede')}</p>
      <div className="sl-actions"><button type="button" className="sl-btn" onClick={onPayments} data-testid="notifications-payments">{t('notifications.toPayments')}</button></div>
    </section>
  );
}

export function DangerZone({ confirming, busy, onAsk, onConfirm, onCancel }: { confirming: boolean; busy: boolean; onAsk: () => void; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('account');
  return (
    <section className="ac-danger" aria-labelledby="danger-heading" data-testid="danger-zone">
      <h2 className="sl-h3" id="danger-heading">{t('danger.title')}</h2>
      <p className="sl-note">{t('danger.lede')}</p>
      <div className="sl-actions">
        {confirming ? (
          <>
            <button type="button" className="sl-btn sl-btn--danger" disabled={busy} onClick={onConfirm} data-testid="disconnect-confirm">{t('danger.confirm')}</button>
            <button type="button" className="sl-btn" disabled={busy} onClick={onCancel} data-testid="disconnect-cancel">{t('danger.cancel')}</button>
          </>
        ) : (
          <button type="button" className="sl-btn sl-btn--danger" onClick={onAsk} data-testid="disconnect">{t('danger.disconnect')}</button>
        )}
      </div>
      <h3 className="sl-h3">{t('danger.dataTitle')}</h3>
      <p className="sl-note">{t('danger.data')} <Link href="/legal/datenschutz">{t('danger.privacy')}</Link></p>
    </section>
  );
}
