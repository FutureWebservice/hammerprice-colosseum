/**
 * The draft without a model: deterministic text from the seller's own fields, German and English. Used when no key is configured, when the
 * budget is spent, when Google fails or the answer is refused. It costs no credit and is labelled "template" in the UI.
 * Also the one place that computes the opening-price suggestion: only ever from the seller's own estimate, never from the model.
 */
import type { z } from 'zod';
import type { AiListingFields as FieldsSchema } from '@/contracts';
import { TITLE_RE } from './filter';

type Fields = z.infer<typeof FieldsSchema>;

/** The share of the seller's own estimate suggested as the opening price (the 40 to 50 percent of the schema comment, middle). */
export const OPENING_SHARE_PERCENT = 45n;
const STEP = 500_000n; // 0.50 USDC

/** USDC base units as a string, or null without an estimate (or when the result would be below one step). */
export function suggestOpening(estimateUsdc: string | undefined): string | null {
  if (!estimateUsdc || !/^\d{1,18}$/.test(estimateUsdc)) return null;
  const v = (BigInt(estimateUsdc) * OPENING_SHARE_PERCENT) / 100n;
  const r = (v / STEP) * STEP;
  return r >= STEP ? r.toString() : null;
}

export const rationaleFor = (opening: string | null, locale: 'de' | 'en'): string => {
  if (!opening) return '';
  return locale === 'de' ? 'Vorschlag: 45 Prozent Ihrer eigenen Schätzung. Das ist keine Bewertung der Karte.' : 'Suggestion: 45 percent of your own estimate. This is not a valuation of the card.';
};

const safeTitle = (s: string, fallback: string): string => {
  const t = s.replace(/[^\p{L}\p{N} .,:;!?'"&()#+/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return t.length >= 3 && TITLE_RE.test(t) ? t : fallback;
};

export function templateDraft(f: Fields) {
  const label = [f.gradingCompany, f.grade].filter(Boolean).join(' ');
  const titleDe = safeTitle([f.name, label].filter(Boolean).join(', '), 'Gradierte Sammelkarte');
  const titleEn = safeTitle([f.name, label].filter(Boolean).join(', '), 'Graded trading card');
  const de = [`Gradierte Sammelkarte: ${f.name}.`, f.setName ? `Set: ${f.setName}.` : '', label ? `Grading laut Label: ${label}.` : '', f.gradingId ? `Grading-ID: ${f.gradingId}.` : '',
    'Die Angaben stammen vom Verkäufer. Zustand und Grading bitte anhand des Labels und der Fotos prüfen.'].filter(Boolean).join(' ');
  const en = [`Graded trading card: ${f.name}.`, f.setName ? `Set: ${f.setName}.` : '', label ? `Grading per the label: ${label}.` : '', f.gradingId ? `Grading ID: ${f.gradingId}.` : '',
    'The details come from the seller. Please check the condition and grading against the label and the photos.'].filter(Boolean).join(' ');
  const opening = suggestOpening(f.estimateUsdc);
  return { titleDe, titleEn, descriptionDe: de.slice(0, 1500), descriptionEn: en.slice(0, 1500), suggestedOpeningUsdc: opening, rationale: rationaleFor(opening, f.locale) };
}
