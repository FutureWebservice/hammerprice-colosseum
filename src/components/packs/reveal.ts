/**
 * The timeline of the opening, as plain data so it can be tested: sealed -> shake -> tear -> burst -> rise -> flip -> shown. Rarer cards
 * take a little longer (more anticipation, never more than about four seconds). `reduced` skips straight to the end.
 */
import type { RarityLevel } from '@/lib/packs/rarity';

export const PHASES = ['sealed', 'shake', 'tear', 'burst', 'rise', 'flip', 'shown'] as const;
export type Phase = (typeof PHASES)[number];

const SHAKE_MS: Record<RarityLevel, number> = { common: 800, uncommon: 900, rare: 1000, epic: 1150, legendary: 1300 };

/** Milliseconds each phase lasts before the next one starts (`shown` and `sealed` are open ended). */
export function phaseDurations(rarity: RarityLevel): Record<Exclude<Phase, 'sealed' | 'shown'>, number> {
  return { shake: SHAKE_MS[rarity], tear: 500, burst: rarity === 'legendary' ? 900 : 700, rise: 600, flip: 950 };
}

/** The phases to walk through, with the delay before each; one entry per step after `sealed`. */
export function timeline(rarity: RarityLevel, reduced: boolean): { phase: Phase; after: number }[] {
  if (reduced) return [{ phase: 'shown', after: 0 }];
  const d = phaseDurations(rarity);
  return [
    { phase: 'shake', after: 250 },
    { phase: 'tear', after: d.shake },
    { phase: 'burst', after: d.tear },
    { phase: 'rise', after: d.burst },
    { phase: 'flip', after: d.rise },
    { phase: 'shown', after: d.flip },
  ];
}

export const totalMs = (rarity: RarityLevel): number => timeline(rarity, false).reduce((n, s) => n + s.after, 0);
