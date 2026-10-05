/** The picture check: bytes in, a verdict out. No database. */
import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_BYTES } from '@/contracts/profile';
import { checkAvatarBytes } from '../avatar';
import { checkUsername, isProfane } from '../rules';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sof = (h: number, w: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
const webpL = (w: number, h: number) => {
  const v = (w - 1) | ((h - 1) << 14);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([10, 0, 0, 0]), Buffer.from([0x2f, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255, 0, 0, 0, 0, 0])]);
};

describe('checkAvatarBytes', () => {
  it('knows png, jpeg and webp by their bytes and reads their size', () => {
    expect(checkAvatarBytes(PNG)).toEqual({ ok: true, type: 'image/png', width: 1, height: 1 });
    expect(checkAvatarBytes(sof(300, 200))).toEqual({ ok: true, type: 'image/jpeg', width: 200, height: 300 });
    expect(checkAvatarBytes(webpL(64, 48))).toEqual({ ok: true, type: 'image/webp', width: 64, height: 48 });
  });

  it('refuses everything else: svg, html, gif, text, a renamed or truncated file', () => {
    const no = (b: Uint8Array | string) => checkAvatarBytes(typeof b === 'string' ? Buffer.from(b) : b);
    expect(no('<svg xmlns="http://www.w3.org/2000/svg"/>')).toEqual({ ok: false, rule: 'avatar_type' });
    expect(no('<html></html>')).toEqual({ ok: false, rule: 'avatar_type' });
    expect(no('GIF89a......................................')).toEqual({ ok: false, rule: 'avatar_type' });
    expect(no(PNG.subarray(0, 30))).toEqual({ ok: false, rule: 'avatar_type' });
    expect(no(Buffer.concat([PNG, Buffer.from('x')]))).toEqual({ ok: false, rule: 'avatar_type' }); // a trailer after IEND
    expect(no(Buffer.concat([sof(10, 10), Buffer.from('x')]))).toEqual({ ok: false, rule: 'avatar_type' });
    expect(no(Buffer.concat([webpL(10, 10), Buffer.from('x')]))).toEqual({ ok: false, rule: 'avatar_type' });
  });

  it('empty is its own answer, and the size cap is exactly 200 KB', () => {
    expect(checkAvatarBytes(new Uint8Array(0))).toEqual({ ok: false, rule: 'avatar_empty' });
    expect(checkAvatarBytes(new Uint8Array(AVATAR_MAX_BYTES + 1))).toEqual({ ok: false, rule: 'avatar_size' });
  });

  it('refuses a picture that claims an absurd number of pixels (a decompression bomb) and one with no pixels', () => {
    expect(checkAvatarBytes(sof(60000, 60000))).toEqual({ ok: false, rule: 'avatar_size' });
    expect(checkAvatarBytes(webpL(16384, 16384))).toEqual({ ok: false, rule: 'avatar_size' });
    expect(checkAvatarBytes(sof(0, 5))).toEqual({ ok: false, rule: 'avatar_size' });
  });
});

describe('checkUsername', () => {
  const rule = (s: string | null) => { const r = checkUsername(s); return r.ok ? 'ok' : r.reason; };
  it('accepts 3 to 24 letters, digits and underscores, exactly as typed', () => {
    for (const n of ['Anna', 'abc', 'a_b', 'Card_Fan_7', 'x'.repeat(24), '123']) expect(rule(n)).toBe('ok');
    expect(checkUsername('  Anna_1 ')).toEqual({ ok: true, value: 'Anna_1' });
  });
  it('empty or null clears it', () => {
    for (const n of ['', '   ', null]) expect(checkUsername(n)).toEqual({ ok: true, value: null });
  });
  it('refuses the wrong length, other characters, the platform\'s names and insults', () => {
    expect(rule('ab')).toBe('too_short');
    expect(rule('x'.repeat(25))).toBe('too_long');
    for (const n of ['two words', 'a-b-c', 'Jörg', 'a.b.c', '<b>x', 'emoji😀x']) expect(rule(n)).toBe('characters');
    for (const n of ['hammerprice', 'Admin', 'support_team', 'H4mmerpr1ce', 'house', 'moderator']) expect(rule(n)).toBe('reserved');
    for (const n of ['fuck_you', 'Sh1t', 'ARSCHLOCH', 'n1gg3r', 'wichser88']) expect(rule(n)).toBe('profane');
  });
  it('the filter does not fire on harmless words that contain a short bad one', () => {
    for (const n of ['assistant', 'classic', 'Scunthorpe', 'cocktail', 'passion', 'Dickens_Fan']) expect(isProfane(n), n).toBe(false);
  });
});
