import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LOGIN_TTL_MS, buildLoginMessage, parseLoginMessage, type LoginFields } from '../login';
import { NOW, actor } from './testkit';

const a = actor();
const fields: LoginFields = {
  host: 'hammerprice.example', wallet: a.wallet, chain: 'devnet', nonce: '5Hq8mC2vYtN3xZ9bKdLw4r',
  issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + LOGIN_TTL_MS).toISOString(),
};

describe('login message', () => {
  it('has the documented layout', () => {
    expect(buildLoginMessage(fields)).toBe(
      `hammerprice.example wants you to sign in with your Solana account:\n${a.wallet}\n\nSign in to Hammerprice. This costs nothing and moves no funds.\n\nURI: https://hammerprice.example\nVersion: 1\nChain ID: devnet\nNonce: 5Hq8mC2vYtN3xZ9bKdLw4r\nIssued At: 2026-10-06T12:00:00.000Z\nExpiration Time: 2026-10-06T12:05:00.000Z`,
    );
  });

  it('round-trips, including a host with a port', () => {
    expect(parseLoginMessage(buildLoginMessage(fields))).toEqual(fields);
    const local = { ...fields, host: 'localhost:3000' };
    expect(parseLoginMessage(buildLoginMessage(local))).toEqual(local);
  });

  it('names http for localhost (the wallet compares the URI with the page origin) and https for every other host', () => {
    expect(buildLoginMessage({ ...fields, host: 'localhost:3000' })).toContain('URI: http://localhost:3000\n');
    expect(buildLoginMessage(fields)).toContain('URI: https://hammerprice.example\n');
  });

  const good = buildLoginMessage(fields);
  const cases: Record<string, string> = {
    'extra line': `${good}\nResources: x`,
    'trailing newline': `${good}\n`,
    'other statement': good.replace('moves no funds', 'moves all funds'),
    'URI for another host': good.replace('URI: https://hammerprice.example', 'URI: https://evil.example'),
    'http scheme': good.replace('https://', 'http://'),
    'version 2': good.replace('Version: 1', 'Version: 2'),
    'unknown chain': good.replace('devnet', 'testnet'),
    'non-ASCII': good.replace('Sign in', 'Sign ín'),
    'uppercase host': good.replaceAll('hammerprice.example', 'Hammerprice.example'),
    'not an instant': good.replace('2026-10-06T12:05:00.000Z', '2026-13-06T12:05:00.000Z'),
    'time without milliseconds': good.replace('12:05:00.000Z', '12:05:00Z'),
    'time with an offset': good.replace('12:05:00.000Z', '12:05:00.000+00:00'),
    'short nonce': good.replace(fields.nonce, 'abc'),
    'CRLF': good.replaceAll('\n', '\r\n'),
    'reordered times': good.replace(/Issued At: (.*)\nExpiration Time: (.*)$/, 'Expiration Time: $2\nIssued At: $1'),
    'empty': '',
  };
  for (const [name, text] of Object.entries(cases)) it(`rejects: ${name}`, () => expect(parseLoginMessage(text)).toBeNull());

  it('a bid intent or paddle text is not a login message', () => {
    expect(parseLoginMessage('hammerprice bid v1\ncluster: devnet')).toBeNull();
  });

  it('no single-byte change of a valid message still parses to the same fields', () => {
    const bytes = new TextEncoder().encode(good);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (i, x) => {
        const m = bytes.slice();
        m[i] ^= x;
        const parsed = parseLoginMessage(new TextDecoder().decode(m));
        // a mutation may still parse (a different nonce is a legal message) but never to the signed fields
        return parsed === null || JSON.stringify(parsed) !== JSON.stringify(fields);
      }),
      { numRuns: 500 },
    );
  });
});
