/**
 * What may leave the model and reach a seller's screen. The model has no tools and no secrets, so the only attack is injected text that
 * makes it write something we would not: a link, a contact, a wallet address, a price promise, a claim about condition or authenticity.
 * Such text is never "repaired": the whole draft is refused and the seller gets the template instead (and the credit back).
 * Markup (markdown, HTML) is only stripped. The title must pass the same rule as a show title.
 */
export const TITLE_RE = /^[\p{L}\p{N} .,:;!?'"&()#+/-]+$/u;

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[\w-]+\.(?:com|net|org|io|de|xyz|app|dev|me|ly|co|sh|gg|fun|eth|sol|ru|cn|info|biz|link|click|top)\b/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,}\b/;
const PHONE_RE = /(?:\+|00)?\d[\d ()/.-]{8,}\d/;
const MONEY_RE = /[$€£]|\b(?:usdc?|eur|euro|dollars?)\b/i;
/** Claims about condition, authenticity or value beyond the printed grading label, in German and English. Lower-case fragments. */
export const FORBIDDEN = [
  'garantier', 'garantie', 'authentisch', 'echtheit', 'wertsteiger', 'investition', 'geldanlage', 'kapitalanlage', 'rendite', 'unterbewertet', 'makellos', 'neuwertig',
  'guarantee', 'authentic', 'investment', 'appreciat', 'return on', 'mint condition', 'perfect condition', 'pristine', 'flawless', 'undervalued', 'risk-free', 'risk free',
] as const;

export type Rejected = { rejected: string };

/** Strips markup and control characters, collapses whitespace. Does not judge. */
export function stripMarkup(s: string, keepNewlines = false): string {
  const t = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1 ') // [text](url) -> text; a URL inside would have been caught before
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '') // a markdown heading marker; a "#" inside a card name ("#151") is the card number, TITLE_RE allows it
    .replace(/[`*_~>|]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '');
  return keepNewlines ? t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : t.replace(/\s+/g, ' ').trim();
}

/**
 * The reason a text must not be shown, or null. Checked on the RAW text first, so a link hidden in markup is still a link.
 * `allow` is what the card itself carries (its printed grade, for example CGC "PRISTINE 10"): quoting it is not a claim of ours, so those exact
 * words are taken out before the claim list is looked at. The same word anywhere else in the text still refuses it.
 */
export function violation(raw: string, allow: readonly string[] = []): string | null {
  if (URL_RE.test(raw)) return 'url';
  if (EMAIL_RE.test(raw)) return 'email';
  if (BASE58_RE.test(raw)) return 'address';
  if (PHONE_RE.test(raw)) return 'phone';
  if (MONEY_RE.test(raw)) return 'money';
  let low = raw.toLowerCase();
  for (const a of allow) if (a.trim().length >= 2) low = low.split(a.trim().toLowerCase()).join(' ');
  for (const f of FORBIDDEN) if (low.includes(f)) return 'claim';
  return null;
}

export function cleanField(raw: unknown, o: { max: number; min?: number; title?: boolean; allow?: readonly string[] }): string | Rejected {
  if (typeof raw !== 'string') return { rejected: 'type' };
  const bad = violation(raw, o.allow);
  if (bad) return { rejected: bad };
  const t = stripMarkup(raw, !o.title);
  if (o.title && t !== raw.replace(/\s+/g, ' ').trim()) return { rejected: 'markup' }; // a title with markup is not repaired
  if (t.length < (o.min ?? 1)) return { rejected: 'short' };
  if (t.length > o.max) return { rejected: 'long' };
  if (o.title && (t.length < 3 || !TITLE_RE.test(t))) return { rejected: 'title' };
  return t;
}
export const isRejected = (v: string | Rejected): v is Rejected => typeof v !== 'string';
