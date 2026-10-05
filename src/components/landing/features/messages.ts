/**
 * The words of the feature registry (src/locales/{de,en}/features.json), per locale. They are no longer drawn on the landing page
 * (the journey blocks carry the features there); the AI page reads its status wording from here.
 */
import en from '@/locales/en/features.json';
import de from '@/locales/de/features.json';
import type { Locale } from '@/lib/i18n';

export type FeatureMessages = typeof en;
export const FEATURE_MESSAGES: Record<Locale, FeatureMessages> = { en, de };
