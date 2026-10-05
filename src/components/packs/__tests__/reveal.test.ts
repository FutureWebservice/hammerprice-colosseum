import { describe, expect, it } from 'vitest';
import { RARITY_LEVELS } from '@/lib/packs/rarity';
import { PHASES, phaseDurations, timeline, totalMs } from '../reveal';

describe('the opening timeline', () => {
  it('walks the phases in order and ends on "shown"', () => {
    for (const r of RARITY_LEVELS) {
      const steps = timeline(r, false).map((s) => s.phase);
      expect(steps).toEqual(['shake', 'tear', 'burst', 'rise', 'flip', 'shown']);
      expect(steps.every((p, i) => PHASES.indexOf(p) === i + 1)).toBe(true);
    }
  });
  it('is short: never more than about four seconds, and rarer cards take a little longer', () => {
    for (const r of RARITY_LEVELS) expect(totalMs(r)).toBeLessThan(5000);
    expect(totalMs('legendary')).toBeGreaterThan(totalMs('common'));
    expect(phaseDurations('epic').shake).toBeGreaterThan(phaseDurations('common').shake);
  });
  it('with reduced motion there is one step: the card is shown at once, no waiting', () => {
    for (const r of RARITY_LEVELS) expect(timeline(r, true)).toEqual([{ phase: 'shown', after: 0 }]);
  });
});
