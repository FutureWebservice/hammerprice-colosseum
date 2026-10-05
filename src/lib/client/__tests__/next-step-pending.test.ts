import { describe, expect, it } from 'vitest';
import { nextStep, settlementFromPending, type NextStepState } from '../next-step';

describe('settlementFromPending: only the buyer\'s open payment speaks to the next-step line', () => {
  it('nothing pending, nothing to say', () => {
    expect(settlementFromPending(null)).toBeNull();
    expect(settlementFromPending(undefined)).toBeNull();
    expect(settlementFromPending([])).toBeNull();
  });
  it('co-sign flow: not signed yet is "pay now", signed and waiting for the seller is the waiting sentence', () => {
    expect(settlementFromPending([{ role: 'buyer', status: 'awaiting_payment' }])).toBe('won');
    expect(settlementFromPending([{ role: 'buyer', status: 'awaiting_payment', buyerSigned: false }])).toBe('won');
    expect(settlementFromPending([{ role: 'buyer', status: 'awaiting_payment', buyerSigned: true }])).toBe('waiting_counterparty');
  });
  it('submitted means the transaction is on chain: "payment sent", not "confirm in your wallet"', () => {
    expect(settlementFromPending([{ role: 'buyer', status: 'submitted', buyerSigned: true }])).toBe('sent');
    expect(nextStep({ wallet: 'W', me: 'ready', usdc: '5000000', hasPaddle: true, show: 'live', standing: 'none', settlement: 'sent' })).toBe('confirming');
  });
  it('awaiting_seller belongs to the cc_marketplace rail and is left unmapped', () => {
    expect(settlementFromPending([{ role: 'buyer', status: 'awaiting_seller' }])).toBeNull();
  });
  it('a seller request is not a buyer sentence ("then the card is yours")', () => {
    expect(settlementFromPending([{ role: 'seller', status: 'awaiting_seller' }])).toBeNull();
  });
  it('a state that is not open gives nothing, and a buyer entry is found behind a seller one', () => {
    expect(settlementFromPending([{ role: 'buyer', status: 'settled' }])).toBeNull();
    expect(settlementFromPending([{ role: 'seller', status: 'awaiting_seller' }, { role: 'buyer', status: 'awaiting_payment' }])).toBe('won');
  });
  it('feeds nextStep: a won lot says pay now, also when the show already ended', () => {
    const base: NextStepState = { wallet: 'W', me: 'ready', usdc: '5000000', hasPaddle: true, show: 'ended', standing: 'none', settlement: null };
    expect(nextStep({ ...base, settlement: settlementFromPending([{ role: 'buyer', status: 'awaiting_payment' }]) })).toBe('won');
    expect(nextStep(base)).toBe('showEnded');
  });
});
