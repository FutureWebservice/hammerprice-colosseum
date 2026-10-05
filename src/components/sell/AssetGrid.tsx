'use client';

import { useTranslations } from 'next-intl';
import type { SellAsset } from '@/contracts/api';
import { Link } from '@/lib/i18n';
import { useReasonText } from './useApiError';
import { MAX_LOTS } from './wizardState';

/**
 * The seller's cards with their eligibility. Only Metaplex Core cards can be sold for now; every other card
 * says why it cannot. A card that is already offered (in a room, a sale or a pack) is greyed out with an "Already listed" chip
 * that links to where it is, and cannot be chosen. With `onToggle` the cards are pickable (the wizard), without it the list is read-only (/sell).
 */
export default function AssetGrid({
  assets, picked, onToggle, max = MAX_LOTS,
}: { assets: SellAsset[]; picked?: ReadonlySet<string>; onToggle?: (asset: SellAsset) => void; max?: number }) {
  const t = useTranslations('sell');
  const reasonText = useReasonText();
  const full = picked ? picked.size >= max : false;
  return (
    <ul className="sl-grid" data-testid="asset-grid">
      {assets.map((a) => {
        const isPicked = picked?.has(a.mint) ?? false;
        const listed = a.listed ?? null;
        const where = listed ? (listed.kind === 'lot' ? (listed.showId ? `/room/${listed.showId}` : null) : `/packs/${listed.packId}`) : null;
        const others = a.reasons.filter((r) => r !== 'already_listed');
        return (
          <li key={a.mint} className={`sl-card${a.eligible ? '' : ' sl-card--off'}${isPicked ? ' sl-card--picked' : ''}`} data-testid="asset-card" data-mint={a.mint} data-eligible={a.eligible} data-listed={listed ? listed.kind : undefined}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
            {a.imageUrl ? <img className="sl-card-img" src={a.imageUrl} alt="" loading="lazy" decoding="async" /> : <div className="sl-card-img sl-card-img--empty" aria-hidden="true" />}
            <div className="sl-card-body">
              <h3 className="sl-card-name">{a.name}</h3>
              <p className="sl-card-meta">
                {a.grade && <span className="sl-tag">{a.grade}</span>}
                <span className="sl-tag sl-tag--dim">{t(`standards.${a.standard}`)}</span>
              </p>
              {listed && (
                <p className="sl-no" data-testid="asset-listed">
                  <span className="sl-tag">{t('assets.listed')}</span>{' '}
                  {where ? <Link href={where} data-testid="asset-listed-link">{t(listed.kind === 'lot' ? 'assets.listedRoom' : 'assets.listedPack')}</Link> : t(listed.kind === 'lot' ? 'assets.listedRoom' : 'assets.listedPack')}
                </p>
              )}
              {a.eligible ? (
                <p className="sl-ok" data-testid="asset-eligible">{t('assets.eligible')}</p>
              ) : (listed && others.length === 0) ? null : (
                <div className="sl-why" data-testid="asset-reasons">
                  <p className="sl-no">{t('assets.notEligible')}</p>
                  <ul>
                    {(others.length > 0 ? others : (['not_found'] as const)).map((r) => (
                      <li key={r}>{reasonText(r, a.standard)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {onToggle && (
                <button
                  type="button"
                  className={`sl-btn${isPicked ? ' sl-btn--primary' : ''}`}
                  data-testid="pick-card"
                  aria-pressed={isPicked}
                  disabled={!a.eligible || (!isPicked && full)}
                  onClick={() => onToggle(a)}
                >
                  {listed ? t('assets.listed') : isPicked ? t('assets.picked') : t('assets.pick')}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
