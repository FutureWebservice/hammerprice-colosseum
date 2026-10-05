/**
 * The startup check of DATABASE_URL (src/db/url.ts, called by src/db/index.ts): a clear error that names the variable and never prints the value.
 * Background: a production build once failed because the pasted value began with terminal escape sequences.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDatabaseUrl } from '../url';

const PASSWORD = ['np', 'g_', 'SuperSecretPassw0rd'].join(''); // built at run time: no secret scanner should mistake the fixture for a password
const GOOD = `postgresql://neondb_owner:${PASSWORD}@ep-quiet-sun-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`;

describe('assertDatabaseUrl', () => {
  it('accepts a Neon pooled URL, a local URL and the dummy URL of the CI build, and returns it unchanged', () => {
    for (const u of [GOOD, 'postgres://postgres:postgres@127.0.0.1:5432/hp', 'postgresql://dummy:dummy@127.0.0.1:5/dummy', 'postgres://u@localhost/db']) expect(assertDatabaseUrl(u)).toBe(u);
  });
  it('is not set: names the variable', () => {
    for (const v of [undefined, '']) expect(() => assertDatabaseUrl(v)).toThrow(/^DATABASE_URL is not set/);
  });
  it('terminal escape sequences, control characters and whitespace anywhere are refused, naming the variable, never the value', () => {
    const bad = [
      `\u001b[200~${GOOD}\u001b[201~`, // a bracketed paste
      `\u001b[?2004h${GOOD}`,
      `${GOOD}\n`, `${GOOD}\r\n`, ` ${GOOD}`, `${GOOD} `, `postgresql://neondb_owner:${PASSWORD}@host/db name`, `postgresql://neondb_owner:${PASSWORD}@ho\tst/db`,
      `${GOOD}\u0000`, `${GOOD}\u007f`, ` ${GOOD}`, `${GOOD} `, `\u0085${GOOD}`,
    ];
    for (const v of bad) {
      let msg = '';
      try { assertDatabaseUrl(v); } catch (e) { msg = (e as Error).message; }
      expect(msg, JSON.stringify(v)).toMatch(/^DATABASE_URL contains a control character or whitespace \(at position \d+ of \d+\)/);
      expect(msg).not.toContain(PASSWORD);
      expect(msg).not.toContain('neon.tech');
      expect(msg).not.toMatch(/\u001b/);
    }
  });
  it('anything that is not a postgres URL with a host is refused, without the value', () => {
    for (const v of ['not a url', 'neon.tech/db', `mysql://u:${PASSWORD}@host/db`, `https://u:${PASSWORD}@host/db`, `postgres://u:${PASSWORD}@/db`, 'postgresql:///db', `${PASSWORD}`]) {
      let msg = '';
      try { assertDatabaseUrl(v); } catch (e) { msg = (e as Error).message; }
      expect(msg, v.replace(PASSWORD, '***')).toMatch(/^DATABASE_URL (?:is not a valid URL|must start with|has no host|contains a control)/);
      expect(msg).not.toContain(PASSWORD);
    }
  });
  it('the name is a parameter (for other variables such as DATABASE_URL_UNPOOLED)', () => {
    expect(() => assertDatabaseUrl('mysql://h/db', 'DATABASE_URL_UNPOOLED')).toThrow(/^DATABASE_URL_UNPOOLED must start with/);
  });
});

describe('src/db/index.ts runs the check before it opens anything', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('a value that starts with an escape sequence stops the import with the variable name and no value', async () => {
    vi.stubEnv('DATABASE_URL', `\u001b[200~postgresql://u:${PASSWORD}@ep-x.neon.tech/db`);
    vi.resetModules();
    const err = await import('../index').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/^DATABASE_URL contains a control character or whitespace/);
    expect(err!.message).not.toContain(PASSWORD);
  });
  it('a missing value still stops it', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    await expect(import('../index')).rejects.toThrow(/^DATABASE_URL is not set/);
  });
});
