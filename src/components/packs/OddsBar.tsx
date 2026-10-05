'use client';

import { formatBps, rarityOf } from '@/lib/packs/rarity';
import { usePackT } from './usePackT';

export interface OddsRow { tier: string; label: { de: string; en: string }; bps: number }

/**
 * The published odds as one simple bar plus the percentage of every tier in words. The bar is drawn from the same numbers as the table (basis points of
 * the committed odds), so it can never say anything the contract does not. `compact` is the card version (no heading line).
 */
export default function OddsBar({ odds, locale, compact = false }: { odds: readonly OddsRow[]; locale: 'de' | 'en'; compact?: boolean }) {
  const t = usePackT();
  const look = rarityOf(odds);
  const total = odds.reduce((a, o) => a + o.bps, 0) || 1;
  const summary = odds.map((o) => `${o.label[locale]} ${formatBps(o.bps, locale)}`).join(', ');
  return (
    <div className={`pk-oddsbar${compact ? ' pk-oddsbar--compact' : ''}`} data-testid="odds-bar">
      <div className="pk-oddsbar-track" role="img" aria-label={`${t('odds.title')}: ${summary}`}>
        {odds.map((o) => <i key={o.tier} data-rarity={look[o.tier]} data-tier={o.tier} style={{ width: `${(o.bps / total) * 100}%` }} />)}
      </div>
      <ul className="pk-oddsbar-legend">
        {odds.map((o) => (
          <li key={o.tier} data-rarity={look[o.tier]} data-testid={`odds-bar-${o.tier}`}>
            <span className="pk-oddsbar-dot" aria-hidden="true" />
            <span className="pk-oddsbar-name">{o.label[locale]}</span>
            <strong className="pk-oddsbar-pct">{formatBps(o.bps, locale)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
