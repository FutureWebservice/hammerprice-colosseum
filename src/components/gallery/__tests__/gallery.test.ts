import { describe, it, expect } from 'vitest';
import { idleDelay, easeOutExpo, capShowcase } from '../Card3D';

describe('idleDelay', () => {
  it('is 0 for the first card', () => {
    expect(idleDelay(0, 5, 20)).toBe(0);
  });
  it('phase-shifts later cards to negative delays, spread across the period', () => {
    expect(idleDelay(1, 4, 20)).toBeCloseTo(-5, 5);
    expect(idleDelay(2, 4, 20)).toBeCloseTo(-10, 5);
    expect(idleDelay(3, 4, 20)).toBeCloseTo(-15, 5);
  });
  it('never divides by zero for an empty list', () => {
    expect(idleDelay(0, 0, 20)).toBe(0);
  });
});

describe('easeOutExpo', () => {
  it('starts at 0 and ends at 1, exactly', () => {
    expect(easeOutExpo(0)).toBe(0);
    expect(easeOutExpo(1)).toBe(1);
  });
  it('never overshoots past 1 - no bounce', () => {
    for (let t = 0; t <= 1; t += 0.1) {
      const v = easeOutExpo(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it('front-loads motion: past the midpoint it is already most of the way there', () => {
    expect(easeOutExpo(0.5)).toBeGreaterThan(0.9);
  });
  it('clamps out-of-range input', () => {
    expect(easeOutExpo(-1)).toBe(0);
    expect(easeOutExpo(2)).toBe(1);
  });
});

describe('capShowcase', () => {
  it('caps a long list to the fan-spinning-up-a-laptop limit', () => {
    const cards = Array.from({ length: 40 }, (_, i) => i);
    expect(capShowcase(cards, 12)).toHaveLength(12);
    expect(capShowcase(cards, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  it('passes a short list through unchanged', () => {
    expect(capShowcase([1, 2], 12)).toEqual([1, 2]);
  });
  it('treats a negative cap as zero, not "no limit"', () => {
    expect(capShowcase([1, 2, 3], -1)).toEqual([]);
  });
});
