/** What a public profile may contain: a table of cases, no database. */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AVATAR_HOSTS, REJECT_TEXT, checkAvatarUrl, checkBio, checkDisplayName, checkProfile } from '../rules';
import { AVATAR_URL_MAX, BIO_MAX, DISPLAY_NAME_MAX, PROFILE_REJECT_REASONS, ProfileUpdateRequest } from '@/contracts/profile';

const name = (raw: string | null | undefined) => checkDisplayName(raw);
const okName = (raw: string) => { const r = name(raw); if (!r.ok) throw new Error(`${raw}: ${r.reason}`); return r.value; };
const why = (r: ReturnType<typeof checkDisplayName>) => (r.ok ? 'ok' : r.reason);

describe('display name', () => {
  it('accepts ordinary names and keeps them as typed (trimmed, one space between words)', () => {
    expect(okName('Anna')).toBe('Anna');
    expect(okName('  Anna   Müller ')).toBe('Anna Müller');
    expect(okName("O'Neil & Sons")).toBe("O'Neil & Sons");
    expect(okName('Jörg_88')).toBe('Jörg_88');
    expect(okName('李雷')).toBe('李雷');
    expect(okName('Karten-Fritz!')).toBe('Karten-Fritz!');
  });

  it('empty, blank or null clears the name', () => {
    for (const raw of ['', '   ', null, '​​', '\u0000\u0007']) expect(name(raw)).toEqual({ ok: true, value: null });
  });

  it('removes control, bidi and zero-width characters before anything else is judged', () => {
    expect(okName('An​na')).toBe('Anna');
    expect(okName('‮Anna')).toBe('Anna'); // right-to-left override cannot reorder the name on screen
    expect(okName('An\u0000na\u0007')).toBe('Anna');
    expect(okName('Anna﻿')).toBe('Anna');
    expect(okName('Ａｎｎａ')).toBe('Anna'); // full-width letters become plain ones (NFKC)
    expect(okName('Anna\n\tMüller')).toBe('Anna Müller');
  });

  it('enforces 2 to 32 characters, counting characters and not UTF-16 units', () => {
    expect(why(name('A'))).toBe('too_short');
    expect(why(name('Ab'))).toBe('ok');
    const words = (n: number) => `${'abcdefgh '.repeat(4)}abcdefgh`.slice(0, n).trim(); // spaces keep a long name from reading as a wallet address
    expect([...words(DISPLAY_NAME_MAX)].length).toBe(DISPLAY_NAME_MAX);
    expect(why(name(words(DISPLAY_NAME_MAX)))).toBe('ok');
    expect(why(name(words(DISPLAY_NAME_MAX + 1)))).toBe('too_long');
    expect(why(name('a'.repeat(DISPLAY_NAME_MAX)))).toBe('contact_data'); // 32 letters in a row read as a wallet address
    expect(why(name('𠀀𠀁 '.repeat(8).trim()))).toBe('ok'); // astral letters count once each: 8 x 3 characters - 1 = 23 characters
    expect([...'𠀀𠀁 '.repeat(11).trim()].length).toBe(32);
    expect(why(name('𠀀𠀁 '.repeat(11).trim()))).toBe('ok');
    expect(why(name('𠀀𠀁 '.repeat(12).trim()))).toBe('too_long');
  });

  it('refuses links, e-mail addresses, handles, phone numbers and wallet addresses', () => {
    for (const bad of ['visit shop.com', 'https://x.io', 'www.deals', 'bit.ly', 'a[.]com', 'deals (dot) com']) {
      expect(['link', 'contact_data', 'characters'], bad).toContain(why(name(bad)) as string);
      expect(why(name(bad)), bad).not.toBe('ok');
    }
    expect(why(name('anna@example.org'))).toBe('contact_data');
    expect(why(name('@anna_cards'))).toBe('contact_data');
    expect(why(name('+49 170 1234567'))).toBe('contact_data');
    expect(why(name('So11111111111111111111111111111111111111112'.slice(0, 40)))).toBe('too_long');
    expect(why(name('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'))).not.toBe('ok');
  });

  it('refuses characters outside letters, digits, spaces and a little punctuation', () => {
    for (const bad of ['Anna <b>', 'Anna❤', 'x = y', 'a/b', 'a;b', 'a"b', 'Anna|Bob', '😀😀']) expect(why(name(bad)), bad).toBe('characters');
  });

  it('refuses names that pose as the platform or its staff, also in look-alike spelling', () => {
    for (const bad of ['Hammerprice', 'hammerprice team', 'Hammer price', 'H4mmerpr1ce', 'Admin', 'Admin 1', 'adm1n', 'Support', 'Moderator', 'House bidder', 'Official', 'Operator2', 'The Hammerprice Seller', 'Hammerprice Support']) {
      expect(why(name(bad)), bad).toBe('reserved');
    }
    for (const fine of ['Hammer Fan', 'Supportive Sam', 'Houseman', 'Admiral Ackbar', 'Priceless', 'Operatic']) expect(why(name(fine)), fine).toBe('ok');
  });

  it('property: whatever comes back is clean, short and stable (checking it again changes nothing)', () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (raw) => {
      const r = name(raw);
      if (!r.ok || r.value === null) return;
      expect([...r.value].length).toBeGreaterThanOrEqual(2);
      expect([...r.value].length).toBeLessThanOrEqual(DISPLAY_NAME_MAX);
      expect(r.value).toBe(r.value.trim());
      expect(r.value).not.toMatch(/\p{Cc}|\p{Cf}|\s{2,}/u);
      expect(name(r.value)).toEqual({ ok: true, value: r.value });
    }), { numRuns: 400 });
  });
});

describe('bio', () => {
  it('accepts a sentence, normalises white space, allows capitals and punctuation', () => {
    expect(checkBio('Collecting graded Pokémon since 2016.\nHappy to answer questions!')).toEqual({ ok: true, value: 'Collecting graded Pokémon since 2016. Happy to answer questions!' });
    expect(checkBio('I LOVE SLABS')).toMatchObject({ ok: true });
  });
  it('empty clears it; the limit is 160 characters', () => {
    expect(checkBio('')).toEqual({ ok: true, value: null });
    expect(checkBio(null)).toEqual({ ok: true, value: null });
    const text = (n: number) => `${'abcd '.repeat(40)}`.slice(0, n).trim();
    expect([...text(BIO_MAX - 1)].length).toBe(BIO_MAX - 1); // 160 characters, the last one a letter
    expect(checkBio(`${text(BIO_MAX - 1)}x`)).toMatchObject({ ok: true });
    expect(checkBio(`${text(BIO_MAX - 1)}xy`)).toMatchObject({ ok: false, field: 'bio', reason: 'too_long' });
  });
  it('refuses links and contact data like the chat does, and strips invisible characters', () => {
    expect(checkBio('see https://example.com')).toMatchObject({ ok: false, reason: 'link' });
    expect(checkBio('mail me anna@example.org')).toMatchObject({ ok: false, reason: 'contact_data' });
    expect(checkBio('call +49 170 1234567')).toMatchObject({ ok: false, reason: 'contact_data' });
    expect(checkBio('find me at @anna_cards')).toMatchObject({ ok: false, reason: 'contact_data' });
    expect(checkBio('hel​lo‮')).toEqual({ ok: true, value: 'hello' });
  });
});

describe('avatar address', () => {
  const good = 'https://d1abc123.cloudfront.net/cards/p.png';
  it('accepts an https address on an allowed host and keeps it', () => {
    expect(checkAvatarUrl(good)).toEqual({ ok: true, value: good });
    expect(checkAvatarUrl(`  ${good}  `)).toEqual({ ok: true, value: good });
    expect(checkAvatarUrl('https://D1ABC.CloudFront.net/a.png')).toEqual({ ok: true, value: 'https://d1abc.cloudfront.net/a.png' });
    expect(checkAvatarUrl(`${good}?v=2`)).toMatchObject({ ok: true });
  });
  it('empty clears it', () => {
    for (const raw of ['', '  ', null]) expect(checkAvatarUrl(raw)).toEqual({ ok: true, value: null });
  });
  it('refuses http, other schemes and addresses that are not addresses', () => {
    expect(checkAvatarUrl('http://d1.cloudfront.net/a.png')).toMatchObject({ ok: false, reason: 'avatar_https' });
    for (const scheme of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://d1.cloudfront.net/a.png', 'file:///etc/passwd', 'blob:https://d1.cloudfront.net/x']) {
      expect(checkAvatarUrl(scheme), scheme).toMatchObject({ ok: false });
    }
    for (const junk of ['not a url', '//d1.cloudfront.net/a.png', 'd1.cloudfront.net/a.png']) expect(checkAvatarUrl(junk), junk).toMatchObject({ ok: false, reason: expect.stringMatching(/avatar_/) });
  });
  it('refuses a host that is not on the image policy list, including look-alikes, the bare domain and other TLDs', () => {
    for (const bad of [
      'https://example.com/a.png', 'https://cloudfront.net/a.png', 'https://evilcloudfront.net/a.png', 'https://cloudfront.net.evil.com/a.png', 'https://d1.cloudfront.net.evil.com/a.png',
      'https://d1.cloudfront.net@evil.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png', 'https://d1.cloudfront.org/a.png',
    ]) {
      expect(checkAvatarUrl(bad), bad).toMatchObject({ ok: false });
    }
    expect(AVATAR_HOSTS).toEqual(['*.cloudfront.net']);
  });
  it('refuses credentials, ports, fragments, control characters and non-ASCII (look-alike) hosts', () => {
    for (const bad of ['https://user:pw@d1.cloudfront.net/a.png', 'https://d1.cloudfront.net:8443/a.png', 'https://d1.cloudfront.net/a.png#x', 'https://d1.cloudfront.net/a\u0000.png', 'https://d1.clоudfront.net/a.png', 'https://d1.cloudfront.net/a b.png', 'https://d1.cloudfront.net/ä.png']) {
      expect(checkAvatarUrl(bad), bad).toMatchObject({ ok: false });
    }
  });
  it('refuses an address longer than the limit', () => {
    expect(checkAvatarUrl(`https://d1.cloudfront.net/${'a'.repeat(AVATAR_URL_MAX)}`)).toMatchObject({ ok: false, reason: 'too_long' });
  });
});

describe('checkProfile (the whole request)', () => {
  it('returns only the fields that were sent, cleaned; absent fields stay untouched', () => {
    expect(checkProfile({ displayName: '  Anna ' })).toEqual({ ok: true, patch: { displayName: 'Anna' } });
    expect(checkProfile({ bio: '' })).toEqual({ ok: true, patch: { bio: null } });
    expect(checkProfile({ displayName: 'Anna', avatarUrl: null })).toEqual({ ok: true, patch: { displayName: 'Anna', avatarUrl: null } });
    expect(checkProfile({})).toEqual({ ok: true, patch: {} });
  });
  it('the first refused field wins and nothing is returned to store', () => {
    expect(checkProfile({ displayName: 'Anna', bio: 'x https://a.com', avatarUrl: 'http://x' })).toEqual({ ok: false, field: 'bio', reason: 'link' });
    expect(checkProfile({ displayName: 'Admin', bio: 'fine' })).toEqual({ ok: false, field: 'displayName', reason: 'reserved' });
  });
  it('every reason has an English sentence', () => {
    for (const r of PROFILE_REJECT_REASONS) expect(REJECT_TEXT[r], r).toBeTypeOf('string');
    expect(Object.keys(REJECT_TEXT).sort()).toEqual([...PROFILE_REJECT_REASONS].sort());
    for (const text of Object.values(REJECT_TEXT)) expect(text).not.toContain('\u2014');
  });
});

describe('the request contract', () => {
  it('is strict, partial and needs at least one field', () => {
    expect(ProfileUpdateRequest.safeParse({}).success).toBe(false);
    expect(ProfileUpdateRequest.safeParse({ displayName: 'a', extra: 1 }).success).toBe(false);
    expect(ProfileUpdateRequest.safeParse({ displayName: null }).success).toBe(true);
    expect(ProfileUpdateRequest.safeParse({ bio: 'x'.repeat(1001) }).success).toBe(false);
    expect(ProfileUpdateRequest.safeParse({ strikes: 1 }).success).toBe(false); // the unique username is not editable here
    expect(ProfileUpdateRequest.safeParse({ displayName: 5 }).success).toBe(false);
  });
});
