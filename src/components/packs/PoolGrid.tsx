'use client';

import type { PackDetailResponse, PackView } from '@/contracts';
import { rarityOf } from '@/lib/packs/rarity';
import { usePackT } from './usePackT';
import { usd } from './format';

/** The whole pool, every card with its rarity: nothing else can come out of the pack. */
export default function PoolGrid({ pack, cards, locale }: { pack: PackView; cards: PackDetailResponse['cards']; locale: 'de' | 'en' }) {
  const t = usePackT();
  const look = rarityOf(pack.odds);
  const label = Object.fromEntries(pack.odds.map((o) => [o.tier, o.label[locale]]));
  const hasValues = cards.some((c) => c.listedValue !== null);
  return (
    <div>
      <ul className="pk-pool" style={{ listStyle: 'none', padding: 0 }} data-testid="pool-grid">
        {cards.map((c) => {
          const gone = c.status === 'drawn' || c.status === 'removed';
          return (
            <li key={c.id} className={`pk-pool-card${gone ? ' is-gone' : ''}`} data-rarity={look[c.tier]} data-status={c.status}>
              {c.imageUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img className="pk-pool-img" src={c.imageUrl} alt="" loading="lazy" decoding="async" />
                : <span className="pk-pool-img pk-pool-img--empty" />}
              {gone && <span className="pk-pool-gone">{c.status === 'drawn' ? t('detail.drawn') : t('detail.removed')}</span>}
              <span className="pk-pool-name">{c.name}</span>
              <span><span className="pk-chip" data-rarity={look[c.tier]}>{label[c.tier] ?? c.tier}</span></span>
              {c.listedValue !== null && <span className="pk-pool-val">{usd(c.listedValue, locale)}</span>}
            </li>
          );
        })}
      </ul>
      {hasValues && <p className="pk-note">{t('detail.listedNote')}</p>}
    </div>
  );
}
