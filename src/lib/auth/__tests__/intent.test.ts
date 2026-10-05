import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { toBase64 } from '../ed25519';
import {
  INTENT_WINDOW_MS, PADDLE_MAX_VALIDITY_MS, buildBidIntent, buildPaddleAuth, paddleAllows, parseBidIntent, parsePaddleAuth,
  verifyBidIntent, verifyPaddleAuth,
} from '../intent';
import { LOT, NOW, SHOW, actor, bidFields, paddleFields, signedBid } from './testkit';

const wallet = actor();
const sessionKey = actor();
const verifyWith = (req: ReturnType<typeof signedBid>, over: Partial<Parameters<typeof verifyBidIntent>[0]> = {}) =>
  verifyBidIntent({ request: req, showId: SHOW, sessionWallet: wallet.wallet, paddleSessionPubkey: sessionKey.wallet, nowMs: NOW, ...over });

describe('bid intent: text', () => {
  it('builds the documented fixed-order text and parses it back', () => {
    const f = bidFields(wallet.wallet);
    const text = buildBidIntent(f);
    expect(text.split('\n')).toEqual([
      'hammerprice bid v1', 'cluster: devnet', `show: ${SHOW}`, `lot: ${LOT}`, 'amount: 120000000',
      `bidder: ${wallet.wallet}`, `paddle: ${f.paddle}`, 'nonce: 9f2c41d07a3be685', `issued: ${NOW}`,
    ]);
    expect(parseBidIntent(text)).toEqual(f);
  });

  it('parses the "no paddle" marker as null', () => {
    expect(parseBidIntent(buildBidIntent(bidFields(wallet.wallet, { paddle: null })))?.paddle).toBeNull();
  });

  it('accepts the contract fixture message', () => {
    const fixture = 'hammerprice bid v1\ncluster: devnet\nshow: 3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10\nlot: 8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11\namount: 120000000\nbidder: 3Cv8UNdmzgmNFGNo6U7iAMHjf3wv6679SZV3BfTWwdiU\npaddle: a4f1c8e3-5b27-4d09-96ae-8c3d7e1b2f18\nnonce: 9f2c41d07a3be685\nissued: 1791223241000';
    expect(parseBidIntent(fixture)).not.toBeNull();
  });

  const good = buildBidIntent(bidFields(wallet.wallet));
  const lines = good.split('\n');
  const cases: Record<string, string> = {
    'extra line at the end': `${good}\nextra: 1`,
    'trailing newline': `${good}\n`,
    'leading newline': `\n${good}`,
    'extra line in the middle': [...lines.slice(0, 4), 'note: hi', ...lines.slice(4)].join('\n'),
    'two fields swapped': [...lines.slice(0, 2), lines[3], lines[2], ...lines.slice(4)].join('\n'),
    'lines reordered': [lines[0], ...lines.slice(1).reverse()].join('\n'),
    'missing line': lines.filter((_, i) => i !== 6).join('\n'),
    'CRLF line ends': lines.join('\r\n'),
    'non-ASCII in a value': good.replace('devnet', 'devnét'),
    'non-ASCII homoglyph in the header': good.replace('hammerprice', 'hammerpriсe'),
    'wrong cluster (mainnet on a devnet site)': good.replace('devnet', 'mainnet-beta'),
    'unknown cluster': good.replace('devnet', 'testnet'),
    'wrong version': good.replace('bid v1', 'bid v2'),
    'uppercase uuid': good.replace(SHOW, SHOW.toUpperCase()),
    'leading zero in amount': good.replace('amount: 120000000', 'amount: 0120000000'),
    'signed amount': good.replace('amount: 120000000', 'amount: -1'),
    'decimal amount': good.replace('amount: 120000000', 'amount: 1.5'),
    'amount with 21 digits': good.replace('amount: 120000000', `amount: 1${'0'.repeat(20)}`),
    'short nonce': good.replace('nonce: 9f2c41d07a3be685', 'nonce: 9f2c41d07a3be68'),
    'uppercase nonce': good.replace('nonce: 9f2c41d07a3be685', 'nonce: 9F2C41D07A3BE685'),
    'bidder not a key': good.replace(wallet.wallet, 'notAKey'),
    'bidder of the wrong length': good.replace(wallet.wallet, wallet.wallet.slice(0, -4) + '1111111'),
    'issued in seconds': good.replace(`issued: ${NOW}`, `issued: ${Math.floor(NOW / 1000)}`),
    'trailing space': good.replace('devnet', 'devnet '),
    'tab separator': good.replace('cluster: ', 'cluster:\t'),
    'empty': '',
  };
  for (const [name, text] of Object.entries(cases)) it(`rejects: ${name}`, () => expect(parseBidIntent(text)).toBeNull());

  it('honours an explicit cluster argument', () => {
    expect(parseBidIntent(good, 'mainnet-beta')).toBeNull();
    expect(parseBidIntent(buildBidIntent(bidFields(wallet.wallet, { cluster: 'mainnet-beta' })), 'mainnet-beta')).not.toBeNull();
  });
});

describe('bid intent: verification', () => {
  it('accepts a wallet-signed intent', () => expect(verifyWith(signedBid(wallet, wallet.wallet, 'wallet'))).toBe(true));
  it('accepts a session-key-signed intent', () => expect(verifyWith(signedBid(sessionKey, wallet.wallet, 'session'))).toBe(true));
  it('accepts a bare self-authenticating wallet intent (no session wallet)', () =>
    expect(verifyWith(signedBid(wallet, wallet.wallet, 'wallet'), { sessionWallet: null })).toBe(true));
  it('accepts uppercase ids in the request body (canonical text is lowercase)', () => {
    const req = signedBid(wallet, wallet.wallet, 'wallet');
    expect(verifyWith({ ...req, lotId: LOT.toUpperCase() }, { showId: SHOW.toUpperCase() })).toBe(true);
  });

  it('rejects a wrong show, lot or amount in the request', () => {
    const req = signedBid(wallet, wallet.wallet, 'wallet');
    expect(verifyWith(req, { showId: '00000000-0000-4000-8000-000000000000' })).toBe(false);
    expect(verifyWith({ ...req, lotId: '00000000-0000-4000-8000-000000000000' })).toBe(false);
    expect(verifyWith({ ...req, amount: '120000001' })).toBe(false);
  });

  it('rejects an intent for another cluster', () => {
    expect(verifyWith(signedBid(wallet, wallet.wallet, 'wallet', { cluster: 'mainnet-beta' }))).toBe(false);
  });

  it('rejects a bidder that is not the established wallet', () => {
    const other = actor();
    expect(verifyWith(signedBid(other, other.wallet, 'wallet'))).toBe(false);
  });

  it('rejects a signature by the wrong key', () => {
    expect(verifyWith(signedBid(actor(), wallet.wallet, 'wallet'))).toBe(false);
    // the paddle key cannot sign as the wallet, nor the wallet as the session
    expect(verifyWith(signedBid(sessionKey, wallet.wallet, 'wallet'))).toBe(false);
    expect(verifyWith(signedBid(wallet, wallet.wallet, 'session'))).toBe(false);
  });

  it('a session-signed intent needs a registered key and a paddle in the text', () => {
    expect(verifyWith(signedBid(sessionKey, wallet.wallet, 'session'), { paddleSessionPubkey: null })).toBe(false);
    expect(verifyWith(signedBid(sessionKey, wallet.wallet, 'session', { paddle: null }))).toBe(false);
  });

  it('enforces the freshness window in both directions, inclusive at the edge', () => {
    const req = signedBid(wallet, wallet.wallet, 'wallet');
    expect(verifyWith(req, { nowMs: NOW + INTENT_WINDOW_MS })).toBe(true);
    expect(verifyWith(req, { nowMs: NOW + INTENT_WINDOW_MS + 1 })).toBe(false);
    expect(verifyWith(req, { nowMs: NOW - INTENT_WINDOW_MS })).toBe(true);
    expect(verifyWith(req, { nowMs: NOW - INTENT_WINDOW_MS - 1 })).toBe(false);
  });

  it('rejects a non-canonical or short signature', () => {
    const req = signedBid(wallet, wallet.wallet, 'wallet');
    expect(verifyWith({ ...req, intent: { ...req.intent, signature: req.intent.signature.slice(0, -4) } })).toBe(false);
    // the last base64 char carries 4 unused bits: changing only those must not give a second valid spelling
    const sig = req.intent.signature;
    const alt = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + '=';
    expect(alt).not.toBe(sig);
    expect(verifyWith({ ...req, intent: { ...req.intent, signature: alt } })).toBe(false);
  });
});

/**
 * THE PROPERTY: a signed message is bound byte for byte. Change any one byte of the signed text and no path
 * accepts it: not with the request adjusted to match the change (only the signature can refuse it), not with the
 * original request (the binding refuses it).
 */
// hundreds of real ed25519 verifications per property: slow under a loaded machine, so the 5 s default timeout is too short (not a verification bug)
describe('every single-byte mutation of a signed bid intent fails', { timeout: 120_000 }, () => {
  const original = signedBid(sessionKey, wallet.wallet, 'session');
  const bytes = new TextEncoder().encode(original.intent.message);

  const accepts = (mutated: Uint8Array): boolean => {
    const text = new TextDecoder().decode(mutated);
    const signature = original.intent.signature;
    // (a) the request still claims the original show, lot and amount
    const a = verifyWith({ ...original, intent: { ...original.intent, message: text, signature } });
    // (b) the request is rewritten to agree with whatever the mutated text says, so only the signature is left to catch it
    const f = parseBidIntent(text);
    const b = f ? verifyBidIntent({
      request: { lotId: f.lot, amount: f.amount, intent: { message: text, signature, signer: 'session' } },
      showId: f.show, sessionWallet: null, paddleSessionPubkey: sessionKey.wallet, nowMs: f.issued,
    }) : false;
    return a || b;
  };

  it('sanity: the unmodified message verifies on both paths', () => {
    expect(accepts(bytes)).toBe(true);
  });

  it('flipping the low bit of every byte position fails (exhaustive over positions)', () => {
    for (let i = 0; i < bytes.length; i++) {
      const m = bytes.slice();
      m[i] ^= 1;
      expect(accepts(m), `byte ${i}`).toBe(false);
    }
  });

  it('any position, any replacement byte fails (fast-check)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (i, x) => {
        const m = bytes.slice();
        m[i] ^= x;
        return !accepts(m);
      }),
      { numRuns: 400 },
    );
  });

  it('inserting or deleting any single byte fails', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: bytes.length }), fc.integer({ min: 0, max: 255 }), fc.boolean(), (i, x, insert) => {
        if (!insert && i === bytes.length) return true; // nothing to delete past the end
        const m = insert ? new Uint8Array([...bytes.slice(0, i), x, ...bytes.slice(i)]) : new Uint8Array([...bytes.slice(0, i), ...bytes.slice(i + 1)]);
        return !accepts(m);
      }),
      { numRuns: 300 },
    );
  });

  it('any single-character change of the signature fails', () => {
    const sig = original.intent.signature;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: sig.length - 1 }), fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('')), (i, c) => {
        if (sig[i] === c) return true;
        const mutated = sig.slice(0, i) + c + sig.slice(i + 1);
        return !verifyWith({ ...original, intent: { ...original.intent, signature: mutated } });
      }),
      { numRuns: 400 },
    );
  });

  it('a random byte string is never accepted as a signature', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (sig) => !verifyWith({ ...original, intent: { ...original.intent, signature: toBase64(sig) } })),
      { numRuns: 200 },
    );
  });
});

describe('paddle authorisation', () => {
  const session = actor();
  const build = (over = {}) => buildPaddleAuth(paddleFields(wallet.wallet, session.wallet, over));
  const input = (message: string, over: Partial<Parameters<typeof verifyPaddleAuth>[0]> = {}) =>
    ({ message, signature: wallet.sign(message), wallet: wallet.wallet, showId: SHOW, nowMs: NOW, ...over });

  it('builds the documented text and parses it back', () => {
    const f = paddleFields(wallet.wallet, session.wallet);
    expect(build().split('\n')).toEqual([
      'hammerprice paddle v1', 'cluster: devnet', `show: ${SHOW}`, `wallet: ${wallet.wallet}`, `session: ${session.wallet}`, 'max: 500000000', `valid: ${NOW + 3_600_000}`,
    ]);
    expect(parsePaddleAuth(build())).toEqual(f);
    expect(parsePaddleAuth(build({ max: null }))?.max).toBeNull();
  });

  it('accepts a wallet-signed authorisation', () => expect(verifyPaddleAuth(input(build()))).toBe(true));

  it('rejects another show, another wallet, another cluster', () => {
    expect(verifyPaddleAuth(input(build(), { showId: '00000000-0000-4000-8000-000000000000' }))).toBe(false);
    expect(verifyPaddleAuth(input(build(), { wallet: session.wallet }))).toBe(false);
    expect(verifyPaddleAuth(input(build({ cluster: 'mainnet-beta' })))).toBe(false);
  });

  it('rejects an expired authorisation and one that lasts more than six hours', () => {
    expect(verifyPaddleAuth(input(build({ valid: NOW })))).toBe(false);
    expect(verifyPaddleAuth(input(build({ valid: NOW - 1 })))).toBe(false);
    expect(verifyPaddleAuth(input(build({ valid: NOW + 1 })))).toBe(true);
    expect(verifyPaddleAuth(input(build({ valid: NOW + PADDLE_MAX_VALIDITY_MS })))).toBe(true);
    expect(verifyPaddleAuth(input(build({ valid: NOW + PADDLE_MAX_VALIDITY_MS + 1 })))).toBe(false);
  });

  it('rejects a signature by any other key, including the session key it authorises', () => {
    const message = build();
    expect(verifyPaddleAuth({ ...input(message), signature: session.sign(message) })).toBe(false);
    expect(verifyPaddleAuth({ ...input(message), signature: actor().sign(message) })).toBe(false);
  });

  it('a bid intent is not a paddle authorisation and the reverse', () => {
    const bid = buildBidIntent(bidFields(wallet.wallet));
    expect(verifyPaddleAuth(input(bid))).toBe(false);
    expect(parsePaddleAuth(bid)).toBeNull();
    expect(parseBidIntent(build())).toBeNull();
  });

  it('rejects a text with an extra line, a swapped order or a non-ASCII character', () => {
    const t = build();
    const l = t.split('\n');
    for (const bad of [`${t}\nmax: 1`, `${t}\n`, [l[0], l[1], l[3], l[2], ...l.slice(4)].join('\n'), t.replace('devnet', 'devnét')]) {
      expect(verifyPaddleAuth(input(bad))).toBe(false);
    }
  });

  it('every single-byte mutation of a signed authorisation fails', () => {
    const message = build();
    const signature = wallet.sign(message);
    const bytes = new TextEncoder().encode(message);
    for (let i = 0; i < bytes.length; i++) {
      const m = bytes.slice();
      m[i] ^= 1;
      const text = new TextDecoder().decode(m);
      const f = parsePaddleAuth(text);
      // adjust the claimed wallet and show to the mutated text so that only the signature can refuse it
      const ok = verifyPaddleAuth({ message: text, signature, wallet: f?.wallet ?? wallet.wallet, showId: f?.show ?? SHOW, nowMs: NOW });
      expect(ok, `byte ${i}`).toBe(false);
    }
  });

  it('paddleAllows: revoked, expired and over-ceiling paddles may not bid', () => {
    const p = { validUntil: new Date(NOW + 1000), maxBid: 100n, revokedAt: null };
    expect(paddleAllows(p, 100n, NOW)).toBe(true);
    expect(paddleAllows(p, 101n, NOW)).toBe(false);
    expect(paddleAllows({ ...p, maxBid: null }, 10n ** 12n, NOW)).toBe(true);
    expect(paddleAllows({ ...p, revokedAt: new Date(NOW - 1) }, 1n, NOW)).toBe(false);
    expect(paddleAllows(p, 1n, NOW + 1000)).toBe(false);
  });
});
