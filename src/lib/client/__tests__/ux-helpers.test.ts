import { describe, expect, it } from 'vitest';
import { NEXT_STEP_KEYS, nextStep, type NextStepState } from '../next-step';
import { placeNear } from '../place';
import { readFlag, writeFlag, type Store } from '../safe-storage';
import { textKey } from '../cluster-text';
import tourDe from '@/locales/de/tour.json';
import tourEn from '@/locales/en/tour.json';

const BASE: NextStepState = { wallet: 'W', me: 'ready', usdc: '5000000', hasPaddle: true, show: 'live', standing: 'none', settlement: null };
const at = (o: Partial<NextStepState>) => nextStep({ ...BASE, ...o });

describe('nextStep: one key per state, most urgent first', () => {
  const table: Array<[string, Partial<NextStepState>, string]> = [
    ['no wallet', { wallet: null, me: 'off', usdc: null, hasPaddle: false }, 'noWallet'],
    ['wallet but signed out', { me: 'signed_out', hasPaddle: false }, 'notVerified'],
    ['still loading /api/me counts as not verified', { me: 'loading' }, 'notVerified'],
    ['verified, no funds', { usdc: '0', hasPaddle: false }, 'noFunds'],
    ['funds unreadable', { usdc: null, hasPaddle: false }, 'noFunds'],
    ['funded, no bidding number', { hasPaddle: false }, 'noPaddle'],
    ['ready on a live show', {}, 'ready'],
    ['leading', { standing: 'leading' }, 'leading'],
    ['outbid', { standing: 'outbid' }, 'outbid'],
    ['all set but the show has not started', { show: 'scheduled' }, 'notOpen'],
    ['won, payment due', { settlement: 'won' }, 'won'],
    ['payment running', { settlement: 'paying' }, 'paying'],
    ['waiting for the other side', { settlement: 'waiting_counterparty' }, 'waitingSeller'],
    ['payment sent, not yet confirmed', { settlement: 'sent' }, 'confirming'],
    ['payment finished', { settlement: 'done' }, 'done'],
    ['show ended, nothing owed', { show: 'ended' }, 'showEnded'],
  ];
  it.each(table)('%s -> %s', (_n, o, key) => expect(at(o)).toBe(key));

  it('a payment outranks the end of the show', () => {
    expect(at({ show: 'ended', settlement: 'won' })).toBe('won');
    expect(at({ show: 'ended', settlement: 'done' })).toBe('done');
  });
  it('onboarding comes before "not open yet", and the show ending comes before onboarding', () => {
    expect(at({ show: 'scheduled', wallet: null, me: 'off' })).toBe('noWallet');
    expect(at({ show: 'ended', wallet: null, me: 'off' })).toBe('showEnded');
  });
  it('the table reaches every key, and every key has a sentence in both languages', () => {
    expect(new Set(table.map((r) => r[2]))).toEqual(new Set(NEXT_STEP_KEYS));
    for (const k of NEXT_STEP_KEYS) {
      expect(tourEn.nextStep[k], `en ${k}`).toBeTruthy();
      expect(tourDe.nextStep[k], `de ${k}`).toBeTruthy();
    }
  });
});

describe('placeNear', () => {
  const view = { w: 1000, h: 800 };
  const card = { w: 300, h: 120 };
  it('goes below the anchor when it fits', () => {
    expect(placeNear({ top: 100, left: 200, bottom: 130, right: 260 }, card, view)).toEqual({ top: 138, left: 200, side: 'below' });
  });
  it('flips above near the bottom edge', () => {
    const p = placeNear({ top: 700, left: 200, bottom: 730, right: 260 }, card, view);
    expect(p.side).toBe('above');
    expect(p.top).toBe(700 - 8 - 120);
  });
  it('stays inside the viewport sideways', () => {
    expect(placeNear({ top: 100, left: 950, bottom: 130, right: 990 }, card, view).left).toBe(1000 - 300 - 8);
    expect(placeNear({ top: 100, left: -40, bottom: 130, right: 0 }, card, view).left).toBe(8);
  });
  it('pins to the bottom edge when neither side has room', () => {
    const p = placeNear({ top: 300, left: 10, bottom: 600, right: 90 }, { w: 300, h: 500 }, view);
    expect(p.side).toBe('edge');
    expect(p.top).toBe(800 - 500 - 8);
  });
});

describe('safe storage', () => {
  const throwing: Store = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  it('reads and writes through a working store', () => {
    const m = new Map<string, string>();
    const s: Store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
    expect(readFlag(s, 'a')).toBeNull();
    expect(writeFlag(s, 'a', '1')).toBe(true);
    expect(readFlag(s, 'a')).toBe('1');
  });
  it('never throws when storage is missing or blocked', () => {
    expect(readFlag(null, 'a')).toBeNull();
    expect(writeFlag(null, 'a', '1')).toBe(false);
    expect(readFlag(throwing, 'a')).toBeNull();
    expect(writeFlag(throwing, 'a', '1')).toBe(false);
  });
});

describe('textKey picks the Main wording only on mainnet and only when it exists', () => {
  const has = (k: string) => k === 'x.payMain';
  it('devnet keeps the plain key', () => expect(textKey('x.pay', 'devnet', has)).toBe('x.pay'));
  it('mainnet takes the sibling', () => expect(textKey('x.pay', 'mainnet-beta', has)).toBe('x.payMain'));
  it('mainnet falls back when there is no sibling', () => expect(textKey('x.other', 'mainnet-beta', has)).toBe('x.other'));
});
