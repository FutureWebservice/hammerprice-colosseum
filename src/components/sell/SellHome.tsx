'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import AssetGrid from './AssetGrid';
import { OfferPackCta } from '@/components/packs/OfferPack';
import MintCard from './MintCard';
import SignInGate from './SignInGate';
import { useAssets, type AssetsState } from './useAssets';
import { useApiError } from './useApiError';
import { readRecent, type RecentShow } from './recent';
import { IS_DEVNET } from './chain-links';
import './sell.css';

/** The body of /sell for a given assets state. Pure, so the loading, error, empty and list states are each testable. */
export function AssetsView({ state, onRetry, mintSlot }: { state: AssetsState; onRetry: () => void; mintSlot?: React.ReactNode }) {
  const t = useTranslations('sell');
  const errorText = useApiError();
  if (state.status === 'loading') return <p className="sl-note" role="status" data-testid="assets-loading">{t('assets.loading')}</p>;
  if (state.status === 'error') {
    return (
      <div className="sl-warn" role="alert" data-testid="assets-error">
        <p>{state.error.code === 'rpc_unavailable' ? t('assets.rpcDown') : errorText(state.error)}</p>
        <button type="button" className="sl-btn" onClick={onRetry}>{t('assets.retry')}</button>
      </div>
    );
  }
  const eligible = state.assets.filter((a) => a.eligible).length;
  // The mint slot is always the last child at the same position: when the first card arrives the list replaces the empty note, and a slot
  // that moved with it would remount and lose its "card minted" confirmation.
  return (
    <>
      {state.assets.length === 0 ? (
        <div data-testid="assets-empty"><p className="sl-lede">{IS_DEVNET ? t('assets.emptyDevnet') : t('assets.empty')}</p></div>
      ) : (
        <>
          <p className="sl-note" data-testid="assets-summary">{t('assets.summary', { total: state.assets.length, eligible })}</p>
          <AssetGrid assets={state.assets} />
        </>
      )}
      {mintSlot}
    </>
  );
}

function Inner({ packs }: { packs: boolean }) {
  const t = useTranslations('sell');
  const { state, reload } = useAssets();
  const [recent, setRecent] = useState<RecentShow[]>([]);
  useEffect(() => setRecent(readRecent()), []);
  const ready = state.status === 'ready' && state.assets.some((a) => a.eligible);

  return (
    <>
      <section aria-labelledby="sell-cards">
        <h2 className="sl-h2" id="sell-cards">{t('home.yourCards')}</h2>
        <p className="sl-note">{t('home.coreOnly')}</p>
        <AssetsView state={state} onRetry={() => void reload()} mintSlot={IS_DEVNET ? <MintCard onMinted={() => void reload()} /> : undefined} />
      </section>

      <div className="sl-actions">
        {ready ? (
          <Link href="/sell/new" className="sl-btn sl-btn--primary" data-testid="new-show">{t('home.newShow')}</Link>
        ) : (
          <span className="sl-btn sl-btn--off" aria-disabled="true" data-testid="new-show">{t('home.newShow')}</span>
        )}
        {!ready && state.status === 'ready' && <span className="sl-note">{t('home.needEligible')}</span>}
      </div>

      {packs && <OfferPackCta />}

      {recent.length > 0 && (
        <section aria-labelledby="sell-recent" data-testid="recent-shows">
          <h2 className="sl-h2" id="sell-recent">{t('home.recent')}</h2>
          <ul className="sl-list">
            {recent.map((r) => (
              <li key={r.id}><Link href={`/sell/${r.id}`}>{r.title}</Link></li>
            ))}
          </ul>
          <p className="sl-note">{t('home.recentNote')}</p>
        </section>
      )}
    </>
  );
}

/** `packs`: FEATURE_PACKS is on, so the second way to sell (a pack of cards with published odds) is offered next to the first. */
export default function SellHome({ packs = false }: { packs?: boolean }) {
  const t = useTranslations('sell');
  return (
    <div className="hp sl">
      <header className="sl-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="sl-h1">{t('home.title')}</h1>
        <p className="sl-lede">{t('home.lede')}</p>
      </header>
      <SignInGate>
        <Inner packs={packs} />
      </SignInGate>
    </div>
  );
}
