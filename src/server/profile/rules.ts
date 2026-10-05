/**
 * What a public profile may contain. Pure (no database, no clock), so the table of cases is a plain unit test.
 *
 * The display name appears next to chat messages and on a seller's room, so it follows the chat's rules (src/server/chat/rules.ts): control, bidding
 * and zero-width characters are removed, no link, e-mail address, handle, phone number or wallet address, and it cannot pose as the platform. The
 * bio follows the same rules. The avatar address is an https address on a host the site's own image policy allows (the Content-Security-Policy
 * `img-src` in next.config.js: CloudFront), nothing with credentials, a port or a fragment: a viewer's browser never contacts a host we do not allow.
 *
 * Like the chat's, these checks are regex based and known to be bypassable (look-alike letters, spaced-out text): the room operator can still
 * mute or block a bidder, and a profile can be reported through the chat report. They are the first filter, not the only one.
 */
import { hasContactData, hasLink, normalizeBody } from '@/server/chat/rules';
import { AVATAR_URL_MAX, BIO_MAX, DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, USERNAME_MAX, USERNAME_MIN, type ProfileField, type ProfileRejectReason } from '@/contracts/profile';

export type FieldResult = { ok: true; value: string | null } | { ok: false; field: ProfileField; reason: ProfileRejectReason };

const len = (s: string): number => [...s].length;

/** Letters, digits, spaces and a little punctuation: no emoji, no symbols that draw like other characters, nothing that looks like markup. */
const NAME_RE = /^[\p{L}\p{N} .,'&()_!-]+$/u;
/** Names that pose as the platform or its staff. Compared on the letters only, so "Hammer price" and "H4mmerprice" style variants of the obvious ones fail too. */
const RESERVED = ['hammerprice', 'admin', 'administrator', 'support', 'moderator', 'operator', 'official', 'staff', 'house', 'housebidder', 'platform', 'system'];
const plain = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const leet = (s: string): string => s.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's');
const RESERVED_RE = new RegExp(`^(?:${RESERVED.join('|')})(?:team|official|staff|support|\\d*)$`);
const isReserved = (name: string): boolean => {
  const p = plain(name);
  const l = leet(p);
  return p.includes('hammerprice') || l.includes('hammerprice') || RESERVED_RE.test(p) || RESERVED_RE.test(l);
};

/** Empty or null clears the field. */
const isEmpty = (raw: string | null | undefined): boolean => raw == null || normalizeBody(raw) === '';

export function checkDisplayName(raw: string | null | undefined): FieldResult {
  if (isEmpty(raw)) return { ok: true, value: null };
  const value = normalizeBody(raw as string);
  const bad = (reason: ProfileRejectReason): FieldResult => ({ ok: false, field: 'displayName', reason });
  if (len(value) < DISPLAY_NAME_MIN) return bad('too_short');
  if (len(value) > DISPLAY_NAME_MAX) return bad('too_long');
  if (hasContactData(value)) return bad('contact_data');
  if (hasLink(value)) return bad('link');
  if (!NAME_RE.test(value)) return bad('characters');
  if (isReserved(value)) return bad('reserved');
  return { ok: true, value };
}

/**
 * A basic filter, not a promise: common English and German insults and sexual terms, looked for inside the name after look-alike digits are turned
 * back into letters and separators are dropped. Short words only match the whole name (so "assistant" is fine). The operator can still block a profile.
 */
const PROFANE_PARTS = ['fuck', 'shit', 'bitch', 'whore', 'slut', 'nigg', 'fagg', 'rapist', 'nazi', 'hitler', 'wichser', 'hurensohn', 'scheiss', 'schlampe', 'arschloch', 'fotze', 'missgeburt', 'penis', 'vagina', 'porn'];
const PROFANE_WHOLE = ['ass', 'cunt', 'cock', 'dick', 'tits', 'piss', 'arsch', 'hure', 'nutte', 'kacke', 'fick', 'spast', 'idiot'];
const unleet = (s: string): string => s.toLowerCase().replace(/[_]/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b').replace(/9/g, 'g').replace(/ß/g, 'ss');
export const isProfane = (name: string): boolean => {
  const l = unleet(name).replace(/[^a-z]/g, '');
  return PROFANE_PARTS.some((w) => l.includes(w)) || PROFANE_WHOLE.includes(l);
};

/** The unique handle: 3 to 24 ASCII letters, digits or underscores, nothing that poses as the platform, nothing profane. Uniqueness is the database's job (it ignores case). */
export function checkUsername(raw: string | null | undefined): FieldResult {
  if (raw == null || raw.trim() === '') return { ok: true, value: null };
  const value = raw.trim();
  const bad = (reason: ProfileRejectReason): FieldResult => ({ ok: false, field: 'username', reason });
  if (len(value) < USERNAME_MIN) return bad('too_short');
  if (len(value) > USERNAME_MAX) return bad('too_long');
  if (!/^[A-Za-z0-9_]+$/.test(value)) return bad('characters');
  if (isReserved(value)) return bad('reserved');
  if (isProfane(value)) return bad('profane');
  return { ok: true, value };
}

export function checkBio(raw: string | null | undefined): FieldResult {
  if (isEmpty(raw)) return { ok: true, value: null };
  const value = normalizeBody(raw as string);
  const bad = (reason: ProfileRejectReason): FieldResult => ({ ok: false, field: 'bio', reason });
  if (len(value) > BIO_MAX) return bad('too_long');
  if (hasContactData(value)) return bad('contact_data');
  if (hasLink(value)) return bad('link');
  return { ok: true, value };
}

/** Hosts an avatar may come from: the site's CSP img-src (next.config.js). A wildcard entry matches any subdomain, never the bare domain. */
export const AVATAR_HOSTS = ['*.cloudfront.net'] as const;
const hostAllowed = (host: string): boolean => AVATAR_HOSTS.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));

export function checkAvatarUrl(raw: string | null | undefined): FieldResult {
  if (raw == null || raw.trim() === '') return { ok: true, value: null };
  const bad = (reason: ProfileRejectReason): FieldResult => ({ ok: false, field: 'avatarUrl', reason });
  const text = raw.trim();
  if (len(text) > AVATAR_URL_MAX) return bad('too_long');
  // Anything that is not plain printable ASCII is refused outright: no look-alike hosts, no smuggled control characters.
  if (!/^[\x21-\x7e]+$/.test(text)) return bad('avatar_invalid');
  let u: URL;
  try { u = new URL(text); } catch { return bad('avatar_invalid'); }
  if (u.protocol !== 'https:') return bad('avatar_https');
  if (u.username || u.password || u.port || u.hash) return bad('avatar_invalid');
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || !hostAllowed(host)) return bad('avatar_host');
  return { ok: true, value: u.toString() };
}

export type ProfilePatch = { username?: string | null; displayName?: string | null; bio?: string | null; avatarUrl?: string | null };

/** Checks every field that is present; the first problem wins. The values are the cleaned ones to store. */
export function checkProfile(input: { username?: string | null; displayName?: string | null; bio?: string | null; avatarUrl?: string | null }): { ok: true; patch: ProfilePatch } | { ok: false; field: ProfileField; reason: ProfileRejectReason } {
  const patch: ProfilePatch = {};
  const steps: [Exclude<ProfileField, 'avatar'>, string | null | undefined, (r: string | null | undefined) => FieldResult][] = [
    ['username', input.username, checkUsername], ['displayName', input.displayName, checkDisplayName], ['bio', input.bio, checkBio], ['avatarUrl', input.avatarUrl, checkAvatarUrl],
  ];
  for (const [field, raw, check] of steps) {
    if (raw === undefined) continue;
    const r = check(raw);
    if (!r.ok) return r;
    patch[field] = r.value;
  }
  return { ok: true, patch };
}

/** English sentence per reason (the API's `reason` text; the form shows its own translated text keyed by `extra.reason`). */
export const REJECT_TEXT: Record<ProfileRejectReason, string> = {
  too_short: `The name needs at least ${DISPLAY_NAME_MIN} characters (a username at least ${USERNAME_MIN})`,
  too_long: 'That is too long',
  characters: 'Use letters, digits, spaces and . , \' & ( ) _ ! - only',
  link: 'Links are not allowed in a profile',
  contact_data: 'E-mail addresses, handles, phone numbers and wallet addresses are not allowed in a profile',
  reserved: 'That name is reserved',
  avatar_https: 'The picture address must start with https://',
  avatar_host: 'The picture must be hosted on an address Hammerprice allows (https://*.cloudfront.net)',
  avatar_invalid: 'That is not a usable picture address',
  taken: 'That username is already taken',
  profane: 'Please choose another username',
  avatar_type: 'The picture must be a png, jpeg or webp image',
  avatar_size: 'The picture is too large (200 KB at most)',
  avatar_empty: 'The picture is empty',
};
