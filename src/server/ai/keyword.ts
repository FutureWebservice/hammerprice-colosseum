/**
 * The assistant without a model: a pure keyword match of the question against the FAQ questions and answers. Used when no key is
 * configured, when the budget is spent or Google fails, and as the guard for advice questions. Same answer texts, labelled "from the FAQ".
 */
import type { FaqEntry, Lang } from './faq';

const STOP: Record<Lang, Set<string>> = {
  en: new Set('a an and are as at be but by can do does for from how i in is it me my of on or so that the this to what when where which who why will with you your please about there their they we our'.split(' ')),
  de: new Set('ab als am an auch auf aus bei bin bis da das dass dem den der des die dies diese dieser doch du ein eine einen einem einer er es euch fuer gibt hab habe haben hat hier ich ihr ihre im in ist ja kann kann kein mein mir mit muss nach nicht noch nun nur oder ob sich sie sind so und uns von vor was wann warum wie wir wird wo wenn zu zum zur ueber'.split(' ')),
};

/** Lower-case, umlauts folded, only letters and digits. */
export function tokens(text: string, lang: Lang): string[] {
  const t = text.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP[lang].has(w));
}
const stem = (w: string) => w.slice(0, 5);

/** Advice-seeking questions get the fixed "no advice" answer, before any model call and without cost. */
export const ADVICE_RE = /\b(soll(?:te)? ich|lohnt|lohnen|empfiehl|empfehlung|worth it|should i|would you (?:buy|bid|sell)|good (?:deal|investment|price)|steuer|steuerlich|tax(?:es|able)?|rechtlich|legal(?:ly)?|lawyer|anwalt|invest|anlage|geldanlage|rendite|profit|gewinn|wertsteiger|wird .* wert|will .* (?:go up|increase)|bester preis|best price to)\b/i;

/** The key of the best entry, or null when nothing matches well enough. */
export function keywordMatch(question: string, lang: Lang, entries: readonly FaqEntry[]): string | null {
  const qt = new Set(tokens(question, lang).map(stem));
  if (qt.size === 0) return null;
  let best: { key: string; score: number } | null = null;
  for (const e of entries) {
    const qTok = new Set(tokens(e.q[lang], lang).map(stem)), aTok = new Set(tokens(e.a[lang], lang).map(stem));
    let score = 0, inQuestion = 0;
    for (const t of qt) { if (qTok.has(t)) inQuestion++; score += (qTok.has(t) ? 2 : 0) + (aTok.has(t) ? 0.5 : 0); }
    score += 0.1 * (inQuestion / Math.max(1, qTok.size)); // a tie goes to the entry whose question is the more specific match
    if (e.extra && inQuestion < 2) score -= 0.6; // our own entries need two matching question words to beat the site FAQ ("What does it cost?" is the fees entry, not the AI drafts)
    if (!best || score > best.score) best = { key: e.key, score };
  }
  // at least two matching question words (or one in the question and one in the answer) and a quarter of the question's words explained
  return best && best.score >= 2 && best.score >= qt.size * 0.5 ? best.key : null;
}
