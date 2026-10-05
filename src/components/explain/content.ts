/**
 * The explain bubble's copy, loaded directly rather than through next-intl's message
 * provider - this component is mounted in SiteChrome, which sits above the provider for
 * room pages too, and adding a namespace there would mean editing shared i18n wiring
 * (src/lib/i18n/request.ts, src/app/[locale]/layout.tsx) that other agents own. Two
 * locales, two static imports; no dynamic loading machinery needed.
 */
import de from '@/locales/de/explain.json';
import en from '@/locales/en/explain.json';
import type { Locale } from '@/lib/i18n';

export type ExplainMessages = typeof de;

const MESSAGES: Record<Locale, ExplainMessages> = { de, en };

export function getExplainMessages(locale: Locale): ExplainMessages {
  return MESSAGES[locale] ?? MESSAGES.en;
}

export const PANEL_KEYS = ['vault', 'room', 'signature', 'hammer', 'settle', 'custody', 'demo'] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];

export const FAQ_KEYS = [
  'solana',
  'packs',
  'commission',
  'reserve',
  'wallet',
  'video',
  'sell',
  'collectorCrypt',
] as const;
export type FaqKey = (typeof FAQ_KEYS)[number];
