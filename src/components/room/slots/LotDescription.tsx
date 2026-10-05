import type { LotDescription as LotDescriptionText } from '@/contracts/common';
import de from '@/locales/de/ai.json';
import en from '@/locales/en/ai.json';
import '@/components/ai/ai.css';

/**
 * Slot: the seller's description of the lot on the block, with the "AI-assisted, reviewed by the seller" note when `aiAssisted`
 * (owner: AI). Mounted by Stage.tsx under the lot line. Renders nothing for a lot without a description. Plain text only (React escapes it).
 * The two note strings come straight from ai.json, so the slot needs no message provider.
 */
export interface LotDescriptionProps {
  description: LotDescriptionText | null;
  aiAssisted: boolean;
  locale: string;
}

export default function LotDescription({ description, aiAssisted, locale }: LotDescriptionProps) {
  const lang = locale.startsWith('de') ? 'de' : 'en';
  const text = (description?.[lang] || description?.[lang === 'de' ? 'en' : 'de'] || '').trim();
  if (!text) return null;
  const note = (lang === 'de' ? de : en).lot.aiAssisted;
  return (
    <div className="ai-lotdesc" data-testid="lot-description">
      <p className="ai-lotdesc-text" lang={description?.[lang] ? lang : lang === 'de' ? 'en' : 'de'}>{text}</p>
      {aiAssisted && <p className="ai-lotdesc-note" data-testid="lot-description-ai">{note}</p>}
    </div>
  );
}
