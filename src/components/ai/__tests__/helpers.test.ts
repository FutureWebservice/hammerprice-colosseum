import { describe, expect, it } from 'vitest';
import { chatLine } from '../chatLine';
import { fitSize } from '../image';
import { clock, liveFacts, usdc } from '../live';

describe('fitSize', () => {
  it('keeps small images, scales the long edge to 1280, keeps the ratio', () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitSize(3000, 4000)).toEqual({ width: 960, height: 1280 });
    expect(fitSize(10_000, 1)).toEqual({ width: 1280, height: 1 });
  });
});

describe('chatLine (the chat takes 200 characters)', () => {
  it('short answers pass unchanged', () => expect(chatLine('Open a room and place a bid.')).toBe('Open a room and place a bid.'));
  it('a long answer is cut at the last sentence that fits, never past 200', () => {
    const a = 'First sentence is here and it is a fairly long one that keeps going for a while. Second sentence is also rather long and keeps going until we pass the limit of the chat line for sure. Third.';
    const l = chatLine(a);
    expect(l.length).toBeLessThanOrEqual(200);
    expect(l.endsWith('.')).toBe(true);
    expect(a.startsWith(l)).toBe(true);
  });
  it('one endless sentence is cut at a word with an ellipsis', () => {
    const l = chatLine('word '.repeat(80));
    expect(l.length).toBeLessThanOrEqual(200);
    expect(l.endsWith('…')).toBe(true);
  });
});

describe('live facts from the public snapshot', () => {
  const snap = (over: Record<string, unknown> = {}) => ({
    v: 1, serverNow: 1_000_000, show: {}, current: { lotId: 'L1', lotNumber: 3, phase: 'open', closesAt: new Date(1_000_000 + 134_000).toISOString(), nextOpensAt: null },
    lots: [{ id: 'L1', lotNumber: 3, state: 'open', highBid: '12500000', highBidder: null, bidCount: 2, closesAt: null }], ...over,
  }) as never;
  it('lot number, high bid and time left from the SERVER clock, not the device clock', () => {
    const f = liveFacts(snap(), 5_000_000); // the device is far off: the offset cancels it
    expect(f).toEqual({ lotNumber: 3, highBidUsdc: '12500000', msLeft: 134_000 });
    expect(clock(f.msLeft!)).toBe('2:14');
    expect(usdc('12500000')).toBe('12.50');
  });
  it('no current lot gives nothing; no bid gives null', () => {
    expect(liveFacts(snap({ current: null }))).toEqual({ lotNumber: null, highBidUsdc: null, msLeft: null });
    expect(liveFacts(snap({ lots: [] })).highBidUsdc).toBeNull();
  });
  it('clock formats hours', () => expect(clock(3_725_000)).toBe('1:02:05'));
});
