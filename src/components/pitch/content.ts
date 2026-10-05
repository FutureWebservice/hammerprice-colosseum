/**
 * The pitch page's copy, loaded the same way the explain bubble's is (see
 * src/components/explain/content.ts): two locales, two static imports, no message-provider
 * wiring. This page is the submission's "document outlining the idea", so it lives on the
 * site rather than in a file a judge would have to be sent separately.
 */
import de from '@/locales/de/pitch.json';
import en from '@/locales/en/pitch.json';
import type { Locale } from '@/lib/i18n';

export type PitchMessages = typeof en;

const MESSAGES: Record<Locale, PitchMessages> = { de, en };

export function getPitchMessages(locale: Locale): PitchMessages {
  return MESSAGES[locale] ?? MESSAGES.en;
}
