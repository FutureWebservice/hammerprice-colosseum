/** The pure helpers of the profile page, the API paths against the contract, and the house style of the account texts (copy guard). */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES } from '@/contracts';
import { AVATAR_MAX_BYTES } from '@/contracts/profile';
import { PROFILE_PATHS, avatarSrc } from '../api';
import { checkPicked } from '../profileDraft';
import { formatDay, formatSol, hash32, identicon } from '../format';

describe('formatSol', () => {
  it('turns lamports into SOL with at most 4 decimals, per locale', () => {
    expect(formatSol('1000000000', 'en')).toBe('1 SOL');
    expect(formatSol('1234567890', 'en')).toBe('1.2345 SOL');
    expect(formatSol('1234567890', 'de')).toBe('1,2345 SOL');
    expect(formatSol('0', 'en')).toBe('0 SOL');
    expect(formatSol('5000', 'en')).toBe('0 SOL');
    expect(formatSol('12345678901234', 'en')).toBe('12,345.6789 SOL');
  });
  it('null or junk is null (the view says "not available"), never NaN', () => {
    for (const bad of [null, undefined, '', 'abc', '-5', '1.5']) expect(formatSol(bad, 'en')).toBeNull();
  });
});

describe('formatDay', () => {
  it('formats the member-since date in the site time zone and survives a bad value', () => {
    expect(formatDay('2026-09-01T10:00:00Z', 'en')).toBe('September 1, 2026');
    expect(formatDay('2026-09-01T10:00:00Z', 'de')).toBe('1. September 2026');
    expect(formatDay('nonsense', 'en')).toBe('');
  });
});

describe('identicon', () => {
  it('is deterministic, mirrored left to right, always has a visible shape, and varies with the seed', () => {
    const a = identicon('3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10');
    expect(identicon('3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10')).toEqual(a);
    for (const row of a.cells) { expect(row[0]).toBe(row[4]); expect(row[1]).toBe(row[3]); }
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = identicon(`profile-${i}`);
      expect(id.cells.flat().filter(Boolean).length, `profile-${i}`).toBeGreaterThanOrEqual(5);
      seen.add(JSON.stringify(id));
    }
    expect(seen.size).toBeGreaterThan(150);
  });
  it('hash32 is a stable unsigned 32 bit number', () => {
    expect(hash32('a')).toBe(hash32('a'));
    expect(hash32('a')).not.toBe(hash32('b'));
    expect(hash32('')).toBe(0x811c9dc5);
  });
});

describe('checkPicked', () => {
  it('stops an empty file, a file over 200 KB and another type before anything is sent', () => {
    expect(checkPicked({ type: 'image/png', size: 1000 })).toBeNull();
    expect(checkPicked({ type: 'image/jpeg', size: AVATAR_MAX_BYTES })).toBeNull();
    expect(checkPicked({ type: 'image/webp', size: 5 })).toBeNull();
    expect(checkPicked({ type: 'image/png', size: AVATAR_MAX_BYTES + 1 })).toBe('avatar_size');
    expect(checkPicked({ type: 'image/png', size: 0 })).toBe('avatar_empty');
    for (const type of ['image/svg+xml', 'image/gif', 'text/html', '']) expect(checkPicked({ type, size: 10 })).toBe('avatar_type');
  });
});

describe('paths', () => {
  it('match the route table, so a rename in the contract fails here instead of in a browser', () => {
    expect(PROFILE_PATHS.meAvatar).toBe(ROUTES.meAvatarSet.path);
    expect(PROFILE_PATHS.meAvatar).toBe(ROUTES.meAvatarClear.path);
    expect(PROFILE_PATHS.meWallet).toBe(ROUTES.meWallet.path);
    expect(PROFILE_PATHS.meSummary).toBe(ROUTES.meSummary.path);
    expect(PROFILE_PATHS.meShows).toBe(ROUTES.meShows.path);
    expect(PROFILE_PATHS.aiCredits).toBe(ROUTES.aiCredits.path);
  });
  it('the picture address carries its version (so it can be cached for a year) and escapes the id', () => {
    expect(avatarSrc('abc', 5)).toBe('/api/avatar/abc?v=5');
    expect(avatarSrc('a/b', 5)).toBe('/api/avatar/a%2Fb?v=5');
  });
});

describe('copy guard for the account texts', () => {
  const SRC = path.join(__dirname, '..', '..', '..');
  const load = (l: string) => fs.readFileSync(path.join(SRC, 'locales', l, 'account.json'), 'utf8');
  const strings = (o: unknown): string[] => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : []);

  it('has no em dash in either language, in the texts or in the code of the page', () => {
    for (const l of ['en', 'de']) expect(load(l)).not.toContain('\u2014');
    const dir = path.join(SRC, 'components', 'account');
    for (const f of fs.readdirSync(dir).filter((x) => /\.(tsx?|css)$/.test(x))) expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toContain('\u2014');
  });

  it('addresses the reader formally in German (Sie), never with du, dein or euch', () => {
    for (const s of strings(JSON.parse(load('de')))) expect(s, s).not.toMatch(/\b(du|dein|deine|deinen|deiner|dir|dich|euch|euer)\b/i);
  });

  it('makes no promise the system does not keep: no "guarantee", "risk-free", "anonymous", "Garantie" or "anonym"', () => {
    for (const s of [...strings(JSON.parse(load('en'))), ...strings(JSON.parse(load('de')))]) expect(s, s).not.toMatch(/guarantee|risk-free|anonymous|garantie|risikofrei|anonym/i);
  });

  it('the privacy text has a part 3.14 for the profile in both languages, with purpose, legal basis, retention and where each value shows', () => {
    const read = (l: string) => fs.readFileSync(path.join(SRC, 'legal', 'content', l, 'datenschutz.md'), 'utf8');
    const part = (t: string) => t.slice(t.indexOf('### 3.14'), t.indexOf('\n## 4.'));
    const en = part(read('en'));
    expect(en).toContain('### 3.14 Your profile (optional)');
    for (const w of ['username', 'display name', 'picture', '200 KB', 'Purpose:', 'Legal basis: Art. 6(1)(a) GDPR', 'Retention and deletion:', 'bidder number only', 'exactly as you upload']) expect(en, w).toContain(w);
    const de = part(read('de'));
    expect(de).toContain('### 3.14 Ihr Profil (optional)');
    for (const w of ['Benutzername', 'Anzeigename', 'Bild', '200 KB', 'Zweck:', 'Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO', 'Speicherdauer und Löschung:', 'nur Ihre Bieternummer', 'genau so']) expect(de, w).toContain(w);
    expect(en).not.toContain('\u2014');
    expect(de).not.toContain('\u2014');
  });

  it('tells the truth about the three places a profile shows: the page, the chat name with the bidder number, and never the bids', () => {
    const en = strings(JSON.parse(load('en'))).join(' ');
    expect(en).toContain('Your username is shown on your profile page only');
    expect(en).toContain('Bids and the bid log always show your bidding number only');
  });
});
