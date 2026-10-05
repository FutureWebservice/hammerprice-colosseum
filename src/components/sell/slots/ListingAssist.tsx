'use client';

import type { LotDescription } from '@/contracts/common';
import type { LotDraft } from '../wizardState';
import ListingPanel from '@/components/ai/ListingPanel';
import AskPanel from '@/components/ai/AskPanel';
import { useAiCredits } from '@/components/ai/useAiCredits';

/**
 * Slot: the AI listing draft and the help assistant in the sell wizard (owner: AI, FEATURE_AI). Mounted by PriceStep. It renders nothing
 * while the feature is off or the seller is signed out. A draft is only ever applied by the seller, field by field, after reviewing it.
 */
export interface ListingAssistProps {
  lots: LotDraft[];
  locale: string;
  /** Adopt reviewed text for one card: its description, whether it came from an AI draft, and optionally a suggested opening price (as typed, USDC). */
  onApply: (mint: string, patch: { description: LotDescription; aiAssisted: boolean; opening?: string }) => void;
}

export default function ListingAssist({ lots, locale, onApply }: ListingAssistProps) {
  const { state, refresh } = useAiCredits();
  if (state.status !== 'ready' || lots.length === 0) return null;
  return (
    <div className="ai-slot" data-testid="ai-slot">
      <ListingPanel lots={lots} locale={locale} credits={state.credits} onCredits={() => void refresh()} onApply={onApply} />
      <AskPanel locale={locale} />
    </div>
  );
}
