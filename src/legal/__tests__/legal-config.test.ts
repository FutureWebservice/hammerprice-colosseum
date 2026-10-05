import { describe, it, expect, vi, afterEach } from 'vitest';
import de from '@/locales/de/legal.json';
import en from '@/locales/en/legal.json';
import { LEGAL, OPERATOR, formatDate, networkNotice, parseNetwork, resolveConfig } from '@/legal/config';
import { assertLegalReady, loadLegalDoc, prepareDoc } from '@/legal/content';
import { LEGAL_KEYS } from '@/legal/routes';
import { CONTENT_DIR } from '@/legal/content';
import fs from 'node:fs';
import path from 'node:path';

const PROD_OK = { NEXT_PUBLIC_SOLANA_NETWORK: 'devnet', NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: 'So11111111111111111111111111111111111111112' };

afterEach(() => vi.unstubAllEnvs());

describe('operator data', () => {
  it('is the owner decision, verbatim', () => {
    expect(OPERATOR.name).toBe('Future Webservice');
    expect(OPERATOR.owner).toBe('Farshad Shadjari');
    expect(OPERATOR.email).toBe('info@futurewebservice.de');
    expect(OPERATOR.addressLines).toEqual(['c/o Autorenglück #78416', 'Albert-Einstein-Straße 47', '02977 Hoyerswerda', 'Deutschland']);
  });

  it('uses the one mailbox for DSA and privacy (no invented aliases)', () => {
    for (const l of ['de', 'en'] as const) {
      const v = LEGAL.values[l];
      expect(new Set([v.CONTACT_EMAIL, v.DSA_CONTACT_EMAIL, v.PRIVACY_CONTACT_EMAIL])).toEqual(new Set(['info@futurewebservice.de']));
    }
  });

  it('states the real regions, not an EU database (A4)', () => {
    expect(LEGAL.values.en.HOSTING_REGION).toBe('Vercel, USA (functions iad1, global CDN)');
    expect(LEGAL.values.en.DB_REGION).toBe('Neon, AWS us-east-1 (USA)');
    for (const l of ['de', 'en'] as const) expect(LEGAL.values[l].DB_REGION).not.toMatch(/Frankfurt|eu-central/i);
  });

  it('formats dates and the fee from the same constants as the code', () => {
    expect(formatDate('2026-09-30', 'de')).toBe('30. September 2026');
    expect(formatDate('2026-09-30', 'en')).toBe('30 September 2026');
    expect(resolveConfig({ PLATFORM_FEE_BPS: '250' }).values.de.PLATFORM_FEE_PERCENT).toBe('2,5 %');
    expect(resolveConfig({ PLATFORM_FEE_BPS: '250' }).values.en.PLATFORM_FEE_PERCENT).toBe('2.5%');
    expect(resolveConfig({ PLATFORM_FEE_BPS: '100' }).values.en.PLATFORM_FEE_PERCENT).toBe('1%');
    // an empty or invalid value falls back to 250, never 0 (.env.example)
    expect(resolveConfig({ PLATFORM_FEE_BPS: '' }).feeBps).toBe(250);
    expect(resolveConfig({ PLATFORM_FEE_BPS: 'abc' }).feeBps).toBe(250);
    // the commission sentence on how-it-works (legal.json) says the same number
    expect(en.commission.rate).toContain(resolveConfig({}).values.en.PLATFORM_FEE_PERCENT);
    expect(de.commission.rate).toContain(resolveConfig({}).values.de.PLATFORM_FEE_PERCENT);
  });

  it('reads the settlement window from SETTLEMENT_WINDOW_S, default 900 s = 15 minutes', () => {
    expect(resolveConfig({}).settlementWindowMinutes).toBe(15);
    expect(resolveConfig({ SETTLEMENT_WINDOW_S: '600' }).settlementWindowMinutes).toBe(10);
  });
});

describe('network mode', () => {
  it('devnet shows the demonstration notice in both languages, mainnet shows none', () => {
    expect(parseNetwork('devnet')).toBe('devnet');
    expect(parseNetwork('')).toBe('devnet');
    expect(parseNetwork('mainnet')).toBe('mainnet');
    expect(parseNetwork('mainnet-beta')).toBe('mainnet');
    expect(parseNetwork('testnet')).toBeNull();
    expect(networkNotice('en', 'devnet')).toMatch(/^\*\*Demonstration mode\.\*\*.*no value/);
    expect(networkNotice('de', 'devnet')).toMatch(/^\*\*Demonstrationsbetrieb\.\*\*.*keinen Wert/);
    expect(networkNotice('en', 'mainnet')).toBe('');
    expect(resolveConfig({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet' }).values.en.NETWORK_MODE_NOTICE).toBe('');
  });

  it('who pays network fees follows the mode (the settlement authority pays on both)', () => {
    expect(resolveConfig({ NEXT_PUBLIC_SOLANA_NETWORK: 'devnet' }).values.en.NETWORK_FEE_TEXT).toMatch(/settlement authority pays/);
    expect(resolveConfig({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet' }).values.en.NETWORK_FEE_TEXT).toMatch(/settlement authority pays the network fees/);
  });
});

describe('UNRESOLVED guard', () => {
  it('lists what nobody knows without the environment: the fee address and the network variable', () => {
    const keys = resolveConfig({}).unresolved.map((u) => u.key);
    expect(keys).toEqual(expect.arrayContaining(['TREASURY_WALLET', 'NETWORK_MODE']));
    expect(keys).not.toContain('LOG_RETENTION'); // checked against the Vercel Hobby plan on 2026-10-01
    expect(resolveConfig(PROD_OK).unresolved.map((u) => u.key)).toEqual([]);
  });

  it('mainnet needs nothing extra: no counsel-review gate (the one switch is SOLANA_CLUSTER)', () => {
    expect(resolveConfig({ ...PROD_OK, NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet' }).unresolved.map((u) => u.key)).toEqual([]);
    expect(resolveConfig({ ...PROD_OK, NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' }).unresolved.map((u) => u.key)).toEqual([]);
  });

  it('fails on a production deployment and only there', () => {
    // The guard is exercised with an explicit list: whether the real one is empty depends on the deploy env.
    const fake = [{ key: 'TREASURY_WALLET', reason: 'unset' }];
    expect(() => assertLegalReady({ VERCEL_ENV: 'production' }, fake)).toThrow(/TREASURY_WALLET/);
    expect(() => assertLegalReady({ VERCEL_ENV: 'development' }, fake)).not.toThrow();
    expect(() => assertLegalReady({ VERCEL_ENV: 'preview' }, fake)).not.toThrow();
    expect(() => assertLegalReady({}, fake)).not.toThrow();
    expect(() => assertLegalReady({ VERCEL_ENV: 'production' }, [])).not.toThrow();
  });

  it('makes every legal page refuse to render on production while something is unresolved', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    for (const key of LEGAL_KEYS) expect(() => loadLegalDoc('en', key), key).toThrow(/not ready for production/);
    vi.stubEnv('VERCEL_ENV', 'development');
    for (const key of LEGAL_KEYS) expect(() => loadLegalDoc('en', key), key).not.toThrow();
  });

  it('refuses a [TBD: ...] marker in strict mode even if the list was emptied', () => {
    const v = { ...LEGAL.values.en };
    expect(() => prepareDoc('# T\n\nWallet: {{TREASURY_WALLET}}', 'en', v, { strict: true })).toThrow(/TBD/);
    expect(() => prepareDoc('# T\n\nWallet: {{TREASURY_WALLET}}', 'en', v)).not.toThrow();
  });
});

describe('production build, both network settings (A4: the build fails on a hole, and there is none)', () => {
  for (const network of ['devnet', 'mainnet-beta']) {
    it(`every text of both languages renders in strict mode with ${network}`, () => {
      const cfg = resolveConfig({ ...PROD_OK, NEXT_PUBLIC_SOLANA_NETWORK: network });
      expect(cfg.unresolved).toEqual([]);
      for (const locale of ['de', 'en'] as const) {
        for (const key of LEGAL_KEYS) {
          const src = fs.readFileSync(path.join(CONTENT_DIR, locale, `${key}.md`), 'utf8');
          expect(() => prepareDoc(src, locale, cfg.values[locale], { strict: true }), `${network} ${locale}/${key}`).not.toThrow();
        }
      }
    });
  }

  it('a missing fee address or network setting is reported as unresolved, so a production build stops', () => {
    expect(resolveConfig({ NEXT_PUBLIC_SOLANA_NETWORK: 'devnet' }).unresolved.map((u) => u.key)).toEqual(['TREASURY_WALLET']);
    expect(resolveConfig({ NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: PROD_OK.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS }).unresolved.map((u) => u.key)).toEqual(['NETWORK_MODE']);
  });
});

describe('placeholders', () => {
  it('an unknown placeholder is an error in every environment', () => {
    expect(() => prepareDoc('# T\n\n{{NOT_A_THING}}', 'en', LEGAL.values.en)).toThrow(/Unknown placeholder/);
  });

  it('drops a line that is only empty placeholders, keeps a line with text around one', () => {
    const v = { ...LEGAL.values.en, PHONE_OPTIONAL: '', W_IDNR_LINE: '' };
    const doc = prepareDoc('# T\n\nEmail: a\n{{PHONE_OPTIONAL}}\n{{W_IDNR_LINE}}\nafter', 'en', v);
    const p = doc.blocks[1] as { t: 'p'; lines: unknown[] };
    expect(p.lines).toHaveLength(2);
  });

  it('strips editor comments', () => {
    const doc = prepareDoc('# T\n\n<!-- secret note -->\nvisible', 'en', LEGAL.values.en);
    expect(JSON.stringify(doc.blocks)).not.toContain('secret');
  });
});
