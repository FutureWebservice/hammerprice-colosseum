/**
 * /[locale]/ai: the AI agent and nothing else. The chat explains itself (welcome message, example chips, the connect card without a wallet, one sentence
 * that the AI can make mistakes and only proposes). When the feature is switched off (the landing page's registry, featureStatus) the page says so instead of drawing a chat that cannot answer.
 * Words: src/locales/{de,en}/aipage.json (metadata and the off note); the chat's own words are in ai.json (agent).
 */
import type { Metadata } from 'next';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/config';
import { pageMetadata } from '@/components/landing/seo';
import { FEATURES, featureStatus } from '@/content/features';
import AgentChat from './AgentChat';
import en from '@/locales/en/aipage.json';
import de from '@/locales/de/aipage.json';
import './ai.css';
import './agent.css';

export type AiPageMessages = typeof en;
export const AI_PAGE_MESSAGES: Record<Locale, AiPageMessages> = { en, de };

const resolve = (l: string): Locale => (isLocale(l) ? l : defaultLocale);
const AI_FEATURE = FEATURES.find((f) => f.id === 'ai')!;

export function aiPageMetadata(locale: string): Metadata {
  const l = resolve(locale);
  const m = AI_PAGE_MESSAGES[l].meta;
  return pageMetadata({ locale: l, path: '/ai', title: m.title, description: m.description });
}

export default function AiPage({ locale, env = process.env }: { locale: string; env?: Record<string, string | undefined> }) {
  const l = resolve(locale);
  const m = AI_PAGE_MESSAGES[l];
  return (
    <div className="aip" lang={l}>
      {featureStatus(AI_FEATURE, env) === 'off' ? (
        <>
          <h1 className="agc-title">{m.title}</h1>
          <p className="aip-off" data-testid="ai-try-off">{m.off}</p>
        </>
      ) : <AgentChat locale={l} />}
    </div>
  );
}
