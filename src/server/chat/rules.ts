/**
 * What a chat message may contain. Pure (no database, no clock), so the table of cases is a plain unit test.
 *
 * The chat is pre-moderated, so these rules are the FIRST filter and the operator is the second: a message that is refused here never
 * reaches the operator's queue. The rules are regex based and therefore known to be bypassable (spaced-out letters, homoglyph
 * domains, "d o t"): that is why every message also waits for a human, and why reporting, muting and blocking exist.
 *
 * Nothing is ever turned into a link: the client renders the text as plain text, so even a message that slipped through is inert.
 */
export const MAX_BODY_CHARS = 200;
export const DUPLICATE_WINDOW_S = 30;

export type RejectReason = 'empty' | 'link' | 'contact_data' | 'too_long' | 'shouting';

/** Control, bidi and zero-width characters: invisible, and the usual way to smuggle text past a filter or to reorder it on screen. */
const INVISIBLE_POINTS: [number, number][] = [[0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0]];
const INVISIBLE = new RegExp(`[\\p{Cc}\\p{Cf}${INVISIBLE_POINTS.map(([a, b]) => String.fromCodePoint(a) + (b > a ? `-${String.fromCodePoint(b)}` : '')).join('')}]`, 'gu');

/** NFKC (so full-width and styled letters become plain ones), invisible characters out, every run of white space one space, trimmed. */
export function normalizeBody(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
}

const TLDS = [
  'com', 'net', 'org', 'io', 'de', 'eu', 'xyz', 'app', 'me', 'co', 'gg', 'ly', 'to', 'tv', 'sh', 'link', 'shop', 'store', 'site', 'online', 'info', 'biz', 'ru', 'cn', 'tk', 'ml', 'ga',
  'cf', 'gq', 'sol', 'so', 'fm', 'ai', 'dev', 'cc', 'ws', 'at', 'ch', 'uk', 'us', 'fr', 'nl', 'it', 'es', 'pl', 'live', 'fun', 'club', 'top', 'vip', 'win', 'bid', 'pro', 'page', 'tech', 'cloud',
];
const LINK_SCHEME = /\b(?:https?|hxxps?|ftp|sftp|ws|wss|mailto|tg|discord)\s*(?::|\[:\]|\(:\))|\bwww\s*\./i;
const LINK_DOMAIN = new RegExp(`(?:^|[^\\p{L}\\p{N}_-])[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${TLDS.join('|')})(?![\\p{L}\\p{N}-])`, 'iu');
/** Dots written so a filter misses them: "[.]", "(.)", "[dot]", "(dot)". Only the bracketed forms: the plain word "dot" is ordinary language. */
const OBFUSCATED_DOT = /[\[(]\s*(?:\.|dot|punkt)\s*[\])]/i;
const KNOWN_SHORTENERS = /\b(?:t\.me|bit\.ly|tinyurl|discord\.gg|wa\.me|linktr\.ee|solscan|solana\.fm)\b/i;

const EMAIL = /[\p{L}\p{N}._%+-]+\s?(?:@|\[at\]|\(at\))\s?[\p{L}\p{N}-]+(?:\.|\s?\[dot\]\s?)[\p{L}]{2,}/iu;
/** A social handle ("@name"): a way to take the conversation out of the room. */
const HANDLE = /(?:^|\s)@[\p{L}\p{N}_]{3,}/u;
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const HEX_RUN = /\b(?:0x)?[0-9a-f]{40,64}\b/i;

/** Digits in a message, ignoring separators: a phone number or an account number has many, a bid amount in words or a lot number has few. */
const digitsIn = (s: string): number => (s.match(/\p{Nd}/gu) ?? []).length;
const PHONE = /(?:\+|00)?\p{Nd}[\p{Nd}\s().\-/]{6,}\p{Nd}/u;

export function hasLink(text: string): boolean {
  return LINK_SCHEME.test(text) || LINK_DOMAIN.test(text) || OBFUSCATED_DOT.test(text) || KNOWN_SHORTENERS.test(text);
}

/** E-mail, handle, phone or account number, wallet address, transaction hash. */
export function hasContactData(text: string): boolean {
  if (EMAIL.test(text) || HANDLE.test(text) || BASE58_RUN.test(text) || HEX_RUN.test(text)) return true;
  const m = PHONE.exec(text);
  return m != null && digitsIn(m[0]) >= 8;
}

/** More than 70 percent capitals among at least 8 letters, or one character five times in a row. */
export function isShouting(text: string): boolean {
  if (/(.)\1{4,}/su.test(text)) return true;
  const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (letters.length < 8) return false;
  return letters.filter((c) => c !== c.toLowerCase()).length / letters.length > 0.7;
}

export const codePointLength = (s: string): number => [...s].length;

/** The normalised text, or the reason it is refused. Order: empty, too long, contact data (an e-mail address also looks like a domain), link, shouting. */
export function checkBody(raw: string): { ok: true; body: string } | { ok: false; reason: RejectReason } {
  const body = normalizeBody(raw);
  if (body.length === 0) return { ok: false, reason: 'empty' };
  if (codePointLength(body) > MAX_BODY_CHARS) return { ok: false, reason: 'too_long' };
  if (hasContactData(body)) return { ok: false, reason: 'contact_data' };
  if (hasLink(body)) return { ok: false, reason: 'link' };
  if (isShouting(body)) return { ok: false, reason: 'shouting' };
  return { ok: true, body };
}

/** English sentence per reason (the API's `reason` text; the client shows its own translated text keyed by `extra.reason`). */
export const REJECT_TEXT: Record<RejectReason, string> = {
  empty: 'The message is empty',
  too_long: `Messages are at most ${MAX_BODY_CHARS} characters`,
  link: 'Links are not allowed in the chat',
  contact_data: 'E-mail addresses, phone numbers, handles and wallet addresses are not allowed in the chat',
  shouting: 'Please do not write in capitals or repeat one character',
};

/** The key of a message for the duplicate check: case, spacing and punctuation do not make a repeat a new message. */
export const duplicateKey = (body: string): string => body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
