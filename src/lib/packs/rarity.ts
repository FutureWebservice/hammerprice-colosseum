/**
 * Rarity as the screen shows it, derived from the PUBLISHED odds only. An operator names tiers freely ("rare", "pristine-10"); the look of a
 * tier comes from how likely it is: the likeliest tier is `common`, the least likely the top look. Pure, no I/O.
 */
export const RARITY_LEVELS = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type RarityLevel = (typeof RARITY_LEVELS)[number];

/** tier id -> look. Ties keep the published order, the less likely (or later) tier gets the higher look. */
export function rarityOf(odds: readonly { tier: string; bps: number }[]): Record<string, RarityLevel> {
  const order = odds.map((o, i) => ({ ...o, i })).sort((a, b) => b.bps - a.bps || a.i - b.i);
  const k = order.length;
  const out: Record<string, RarityLevel> = {};
  order.forEach((o, rank) => {
    const level = k === 1 ? 0 : Math.round((rank * (RARITY_LEVELS.length - 1)) / (k - 1));
    out[o.tier] = RARITY_LEVELS[Math.min(level, RARITY_LEVELS.length - 1)]!;
  });
  return out;
}

/** "5 %", "0.56 %": basis points as a percentage without trailing zeros. */
export function formatBps(bps: number, locale: string = 'en'): string {
  const pct = bps / 100;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(pct)} %`;
}
