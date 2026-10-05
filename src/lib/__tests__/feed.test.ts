import { describe, it, expect } from 'vitest';
import { resolveLotNumber } from '../feed';

const LOTS = [
  { id: 'lot-a', lotNumber: 1 },
  { id: 'lot-b', lotNumber: 7 },
];

describe('resolveLotNumber', () => {
  it('prefers the number the writer denormalized into the payload', () => {
    expect(resolveLotNumber({ lotId: 'lot-a', lotNumber: 7 }, LOTS)).toBe(7);
  });

  it('uses the payload even when the catalogue has not loaded yet', () => {
    // The replay case: EventSource flushes buffered events from Last-Event-ID before the
    // room's own fetch resolves. This is the whole reason the payload carries the number.
    expect(resolveLotNumber({ lotId: 'lot-a', lotNumber: 3 }, undefined)).toBe(3);
  });

  it('falls back to the catalogue for events written before lotNumber was denormalized', () => {
    expect(resolveLotNumber({ lotId: 'lot-b' }, LOTS)).toBe(7);
  });

  it('returns undefined for an old event replayed before the catalogue loads', () => {
    // The bug this module exists for. Callers must omit the lot reference here rather than
    // render "lot " with an empty number.
    expect(resolveLotNumber({ lotId: 'lot-b' }, undefined)).toBeUndefined();
  });

  it('returns undefined when the lot is not in the catalogue', () => {
    expect(resolveLotNumber({ lotId: 'lot-gone' }, LOTS)).toBeUndefined();
  });

  it('treats lot 0 as a real lot number, not as absent', () => {
    expect(resolveLotNumber({ lotId: 'lot-a', lotNumber: 0 }, LOTS)).toBe(0);
  });

  it('ignores a non-integer lotNumber and falls back', () => {
    expect(resolveLotNumber({ lotId: 'lot-a', lotNumber: '7' }, LOTS)).toBe(1);
    expect(resolveLotNumber({ lotId: 'lot-a', lotNumber: null }, LOTS)).toBe(1);
    expect(resolveLotNumber({ lotId: 'lot-a', lotNumber: 1.5 }, LOTS)).toBe(1);
  });

  it('returns undefined when the payload carries no usable identifier at all', () => {
    expect(resolveLotNumber({}, LOTS)).toBeUndefined();
    expect(resolveLotNumber({ lotId: 42 }, LOTS)).toBeUndefined();
  });
});
