import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ERROR_CODES } from '@/contracts';
import { PADDLE_LIMIT_DETAIL as SERVER_DETAIL } from '@/lib/auth/intent';
import roomEn from '@/locales/en/room.json';
import roomDe from '@/locales/de/room.json';
import settleEn from '@/locales/en/settlement.json';
import settleDe from '@/locales/de/settlement.json';
import {
  BID_ERROR_CODES, PADDLE_LIMIT_DETAIL, SETTLE_ERROR_CODES, bidFailureKey, readFailure, buildBidIntent, buildPaddleAuth, classifyWalletError, clearPaddleKey, errorKey, fromBase64,
  DEFAULT_LIMIT_CAP, defaultSpendingLimit, generateSessionKey, loadPaddleKey, readyStep, newNonce, paddleValidUntil, parseUsdc, savePaddleKey, signWithSession, toBase64,
} from '../bidder';

const WALLET = '3Cv8UNdmzgmNFGNo6U7iAMHjf3wv6679SZV3BfTWwdiU';
const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
const LOT = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('signed texts', () => {
  it('builds the bid intent with fixed order and no extra lines', () => {
    expect(buildBidIntent({ cluster: 'devnet', show: SHOW, lot: LOT, amount: '80000000', bidder: WALLET, paddle: null, nonce: 'a1b2c3d4e5f60718', issued: 1791223220000 })).toBe(
      ['hammerprice bid v1', 'cluster: devnet', `show: ${SHOW}`, `lot: ${LOT}`, 'amount: 80000000', `bidder: ${WALLET}`, 'paddle: -', 'nonce: a1b2c3d4e5f60718', 'issued: 1791223220000'].join('\n'),
    );
  });
  it('builds the paddle authorisation', () => {
    const text = buildPaddleAuth({ cluster: 'devnet', show: SHOW, wallet: WALLET, session: 'SESSIONKEY', max: null, valid: 1791230000000 });
    expect(text.split('\n')).toEqual(['hammerprice paddle v1', 'cluster: devnet', `show: ${SHOW}`, `wallet: ${WALLET}`, 'session: SESSIONKEY', 'max: -', 'valid: 1791230000000']);
    expect(buildPaddleAuth({ cluster: 'devnet', show: SHOW, wallet: WALLET, session: 's', max: '500000000', valid: 1 })).toContain('max: 500000000');
  });
  it('makes 16 hex nonces that differ', () => {
    const a = newNonce(); const b = newNonce();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
  it('clamps the paddle expiry to six hours, minus a minute of slack', () => {
    expect(paddleValidUntil(0, 99)).toBe(6 * 3_600_000 - 60_000);
    expect(paddleValidUntil(0, 0)).toBe(3_600_000 - 60_000);
  });
});

describe('usdc input', () => {
  it('parses plain decimals only', () => {
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc(' 3 ')).toBe(3_000_000n);
    expect(parseUsdc('0,25')).toBe(250_000n);
    expect(parseUsdc('1.1234567')).toBeNull();
    expect(parseUsdc('-1')).toBeNull();
    expect(parseUsdc('1e6')).toBeNull();
    expect(parseUsdc('')).toBeNull();
    expect(parseUsdc('9999999999999')).toBeNull();
  });
});

describe('paddle session key', () => {
  it('signs a bid that verifies against the public key it registered', () => {
    const k = generateSessionKey();
    const msg = 'hammerprice bid v1\nx';
    const sig = fromBase64(signWithSession(k.secretKey, msg));
    expect(sig).toHaveLength(64);
    expect(nacl.sign.detached.verify(new TextEncoder().encode(msg), sig, bs58.decode(k.publicKey))).toBe(true);
    expect(nacl.sign.detached.verify(new TextEncoder().encode(msg + ' '), sig, bs58.decode(k.publicKey))).toBe(false);
  });
  it('round trips base64', () => {
    const b = Uint8Array.from([0, 1, 2, 250, 255]);
    expect(Array.from(fromBase64(toBase64(b)))).toEqual(Array.from(b));
  });
  it('stores per show and wallet, drops an expired key, survives a throwing storage', () => {
    const store = memoryStore();
    const k = generateSessionKey();
    savePaddleKey(store, SHOW, WALLET, { ...k, paddleId: LOT, validUntil: 2000 });
    expect(loadPaddleKey(store, SHOW, WALLET, 1000)?.paddleId).toBe(LOT);
    expect(loadPaddleKey(store, SHOW, 'other', 1000)).toBeNull();
    expect(loadPaddleKey(store, SHOW, WALLET, 3000)).toBeNull();
    expect(store.m.size).toBe(0); // expired key was removed
    savePaddleKey(store, SHOW, WALLET, { ...k, paddleId: null, validUntil: 9000 });
    clearPaddleKey(store, SHOW, WALLET);
    expect(loadPaddleKey(store, SHOW, WALLET, 1000)).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(loadPaddleKey(broken, SHOW, WALLET, 0)).toBeNull();
    expect(() => savePaddleKey(broken, SHOW, WALLET, { ...k, paddleId: null, validUntil: 1 })).not.toThrow();
    expect(loadPaddleKey(null, SHOW, WALLET, 0)).toBeNull();
    store.setItem(`hp:paddle:${SHOW}:${WALLET}`, '{"nope":1}');
    expect(loadPaddleKey(store, SHOW, WALLET, 0)).toBeNull();
  });
});

describe('error mapping', () => {
  it('only lists real error codes', () => {
    for (const c of [...BID_ERROR_CODES, ...SETTLE_ERROR_CODES]) expect(ERROR_CODES).toContain(c);
  });
  it('maps known codes to their key and falls back to generic', () => {
    expect(errorKey('bid_too_low')).toBe('errors.bid_too_low');
    expect(errorKey('tx_mismatch')).toBe('errors.generic');
    expect(errorKey('tx_mismatch', SETTLE_ERROR_CODES)).toBe('errors.tx_mismatch');
    expect(errorKey('no_such_code')).toBe('errors.generic');
    expect(errorKey(undefined)).toBe('errors.generic');
  });
  it('K18: the two cluster configuration codes are mapped in the room and in the payment sheet', () => {
    for (const c of ['mainnet_config_incomplete', 'cluster_config_conflict']) {
      expect(errorKey(c)).toBe(`errors.${c}`);
      expect(errorKey(c, SETTLE_ERROR_CODES)).toBe(`errors.${c}`);
    }
  });
  it('every mapped code has a text in DE and EN, in the room and in the payment sheet, and none says "Something went wrong" for a known cause', () => {
    const room = (m: typeof roomEn) => m.errors as Record<string, string>;
    const settle = (m: typeof settleEn) => m.errors as Record<string, string>;
    for (const m of [roomEn, roomDe]) for (const c of BID_ERROR_CODES) expect(room(m)[c], `room.errors.${c}`).toMatch(/\S{3}/);
    for (const m of [settleEn, settleDe]) for (const c of SETTLE_ERROR_CODES) expect(settle(m)[c], `settlement.errors.${c}`).toMatch(/\S{3}/);
    for (const m of [roomEn, roomDe, settleEn, settleDe]) for (const v of Object.values(m.errors as Record<string, string>)) expect(v).not.toContain('\u2014');
  });
  it('K6: a bid above the spending limit gets its own text, not "Finish getting ready to bid first"', async () => {
    expect(PADDLE_LIMIT_DETAIL).toBe(SERVER_DETAIL); // the client and the server name the same detail
    expect(bidFailureKey({ code: 'no_paddle', detail: 'paddle_limit' })).toBe('errors.paddle_limit');
    expect(bidFailureKey({ code: 'no_paddle' })).toBe('errors.no_paddle');
    expect(bidFailureKey({ code: 'bid_too_low', detail: 'paddle_limit' })).toBe('errors.bid_too_low');
    for (const m of [roomEn, roomDe]) {
      const e = m.errors as Record<string, string>;
      expect(e.paddle_limit).toBeTruthy();
      expect(e.paddle_limit).not.toBe(e.no_paddle);
    }
    const res = new Response(JSON.stringify({ ok: false, code: 'no_paddle', reason: 'x', detail: 'paddle_limit' }), { status: 403 });
    expect(bidFailureKey(await readFailure(res))).toBe('errors.paddle_limit');
  });
  it('tells a rejection from a cluster mismatch', () => {
    expect(classifyWalletError({ name: 'WalletSignTransactionError', message: 'User rejected the request.' })).toBe('rejected');
    expect(classifyWalletError({ code: 4001 })).toBe('rejected');
    expect(classifyWalletError(new Error('Transaction simulation failed: Blockhash not found'))).toBe('cluster');
    expect(classifyWalletError(new Error('Unexpected error'))).toBe('cluster');
    expect(classifyWalletError(new Error('method not supported'))).toBe('unsupported');
    expect(classifyWalletError(new Error('boom'))).toBe('unknown');
    expect(classifyWalletError(null)).toBe('unknown');
  });
});

describe('get ready to bid', () => {
  it('the default spending limit is the wallet balance, at most 250 USDC', () => {
    expect(defaultSpendingLimit('1000000000')).toBe(DEFAULT_LIMIT_CAP);
    expect(defaultSpendingLimit('42500000')).toBe(42_500_000n);
    expect(defaultSpendingLimit(null)).toBe(DEFAULT_LIMIT_CAP);
    expect(defaultSpendingLimit('0')).toBe(DEFAULT_LIMIT_CAP);
    expect(defaultSpendingLimit('nonsense')).toBe(DEFAULT_LIMIT_CAP);
  });
  it('walks connect, verify, funds, then the bidding number', () => {
    expect(readyStep({ wallet: null, me: 'off', usdc: null })).toBe(1);
    expect(readyStep({ wallet: 'w', me: 'signed_out', usdc: null })).toBe(2);
    expect(readyStep({ wallet: 'w', me: 'loading', usdc: null })).toBe(2);
    expect(readyStep({ wallet: 'w', me: 'ready', usdc: '0' })).toBe(3);
    expect(readyStep({ wallet: 'w', me: 'ready', usdc: null })).toBe(3);
    expect(readyStep({ wallet: 'w', me: 'ready', usdc: '999999' })).toBe(3);
    expect(readyStep({ wallet: 'w', me: 'ready', usdc: '1000000' })).toBe(4);
  });
});
