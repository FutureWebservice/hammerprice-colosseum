import { describe, expect, it } from 'vitest';
import type { PackDrawView } from '@/contracts';
import { errorKey, followKey, newClientSeed, payStepOf, secondsLeft, stateAfterFollow, stateAfterPoll, statusKey, type PurchaseState } from '../purchase';

const draw = (status: PackDrawView['status']): PackDrawView => ({ id: 'd', status } as PackDrawView);
const waiting = (roundExpiresAt: string | null = null): Extract<PurchaseState, { kind: 'waiting' }> => ({ kind: 'waiting', draw: draw('reserved'), on: 'operator', roundExpiresAt });

describe('newClientSeed', () => {
  it('is 32 lowercase hex characters from the random source it is given', () => {
    expect(newClientSeed((a) => a.fill(0xab))).toBe('ab'.repeat(16));
    const s = newClientSeed();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
    expect(newClientSeed()).not.toBe(s);
  });
});

describe('errorKey', () => {
  it('maps wallet failures, the daily cap and unknown codes to a text that says nothing was charged', () => {
    expect(errorKey('wallet', { wallet: 'rejected' })).toBe('walletRejected');
    expect(errorKey('wallet', { wallet: 'cluster' })).toBe('walletCluster');
    expect(errorKey('wallet', { wallet: 'unsupported' })).toBe('walletUnsupported');
    expect(errorKey('wallet')).toBe('walletUnknown');
    expect(errorKey('rate_limited', { retryAfterS: 30 })).toBe('rate_limited');
    expect(errorKey('rate_limited', { retryAfterS: 40_000 })).toBe('rate_limited_day');
    expect(errorKey('insufficient_usdc')).toBe('insufficient_usdc');
    expect(errorKey('review')).toBe('review');
    expect(errorKey('something_new')).toBe('generic');
  });
});

describe('secondsLeft and statusKey', () => {
  it('counts down to a time and never goes below zero', () => {
    expect(secondsLeft('2026-10-05T12:01:00.000Z', Date.parse('2026-10-05T12:00:30.200Z'))).toBe(30);
    expect(secondsLeft('2026-10-05T12:01:00.000Z', Date.parse('2026-10-05T12:05:00.000Z'))).toBe(0);
    expect(secondsLeft(null, 0)).toBeNull();
    expect(secondsLeft('garbage', 0)).toBeNull();
  });
  it('names the step the screen is in', () => {
    expect(statusKey({ kind: 'idle' })).toBeNull();
    expect(statusKey({ kind: 'working', stage: 'drawing' })).toBe('step.drawing');
    expect(statusKey(waiting())).toBe('step.waitingOperator');
    expect(statusKey({ ...waiting(), on: 'chain' })).toBe('step.paying');
    expect(statusKey({ kind: 'lapsed', draw: null })).toBe('step.lapsed');
  });
});

describe('stateAfterPoll', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z');
  it('settled shows the card, expired and failed end the purchase, and nothing is revealed early', () => {
    expect(stateAfterPoll(draw('settled'), waiting(), now)).toMatchObject({ kind: 'settled' });
    expect(stateAfterPoll(draw('expired'), waiting(), now)).toMatchObject({ kind: 'ended', reason: 'expired' });
    expect(stateAfterPoll(draw('failed'), waiting(), now)).toMatchObject({ kind: 'ended', reason: 'failed' });
  });
  it('a submitted payment is waiting on the chain; a round that ran out unsigned is lapsed (nothing was charged)', () => {
    expect(stateAfterPoll(draw('submitted'), waiting(), now)).toMatchObject({ kind: 'waiting', on: 'chain' });
    expect(stateAfterPoll(draw('reserved'), waiting('2026-10-05T11:59:00.000Z'), now)).toMatchObject({ kind: 'lapsed' });
    expect(stateAfterPoll(draw('reserved'), waiting('2026-10-05T12:00:30.000Z'), now)).toMatchObject({ kind: 'waiting', on: 'operator' });
  });
});

describe('pay first: following a purchase', () => {
  it('names the step of every state, from payment to delivery, and the way back', () => {
    expect(statusKey({ kind: 'following', draw: draw('confirming') })).toBe('step.confirming');
    expect(followKey('paid')).toBe('step.drawAfter');
    expect(followKey('drawn')).toBe('step.drawn');
    expect(followKey('delivering')).toBe('step.delivering');
    expect(followKey('drawn', true)).toBe('step.waitingDelivery'); // a third-party draw waits for its operator
    expect(['awaiting_payment', 'confirming', 'paid', 'drawn', 'delivering', 'settled'].map((st) => payStepOf(st as never)))
      .toEqual(['pay', 'confirm', 'draw', 'draw', 'deliver', 'done']);
    expect(payStepOf('drawn', true)).toBe('deliver');
  });
  it('a followed purchase ends in the card (delivered), the not-delivered screen, an ended purchase, or a payment that did not land (nothing charged)', () => {
    expect(stateAfterFollow(draw('settled'))).toMatchObject({ kind: 'settled' });
    expect(stateAfterFollow(draw('undelivered'))).toMatchObject({ kind: 'undelivered' });
    expect(stateAfterFollow(draw('expired'))).toMatchObject({ kind: 'ended', reason: 'expired' });
    expect(stateAfterFollow(draw('failed'))).toMatchObject({ kind: 'ended', reason: 'failed' });
    expect(stateAfterFollow(draw('awaiting_payment'))).toMatchObject({ kind: 'lapsed' });
    // nothing is revealed on the way: every state in between keeps following
    for (const s of ['confirming', 'paid', 'drawn', 'delivering']) expect(stateAfterFollow(draw(s as never)).kind).toBe('following');
  });
});
