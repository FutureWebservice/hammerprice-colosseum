'use client';

import type { PackView } from '@/contracts';
import { formatBps, rarityOf } from '@/lib/packs/rarity';
import { usePackT } from './usePackT';

/** The published odds, one row per rarity, with how many cards of it are still in the pool. Always visible before a purchase. */
export default function OddsTable({ pack, locale }: { pack: PackView; locale: 'de' | 'en' }) {
  const t = usePackT();
  const look = rarityOf(pack.odds);
  return (
    <div>
      <table className="pk-odds" data-testid="odds-table">
        <thead>
          <tr><th scope="col">{t('odds.rarity')}</th><th scope="col" className="num">{t('odds.chance')}</th><th scope="col" className="num">{t('odds.left')}</th></tr>
        </thead>
        <tbody>
          {pack.odds.map((o) => (
            <tr key={o.tier} data-rarity={look[o.tier]} data-testid={`odds-${o.tier}`}>
              <td>
                <span className="pk-chip" data-rarity={look[o.tier]}>{o.label[locale]}</span>
                <span className="pk-odds-bar" aria-hidden="true"><i style={{ width: `${o.bps / 100}%` }} /></span>
              </td>
              <td className="num">{formatBps(o.bps, locale)}</td>
              <td className="num">{o.remaining} / {o.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
