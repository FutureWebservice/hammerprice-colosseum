'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { z } from 'zod';
import type { AiListingResponse, LotDescription } from '@/contracts';
import { baseToInput, formatUsdc } from '@/components/sell/money';

type Res = z.infer<typeof AiListingResponse>;

/**
 * The draft, always marked ("AI draft, seller reviews" or "Template"), editable, and adopted only after the seller ticks "I have reviewed
 * the text". Nothing leaves this component without that tick. Adopting sets `aiAssisted` only when a model wrote the text.
 */
export default function DraftView({ res, locale, onApply, applied }: {
  res: Res;
  locale: string;
  onApply: (p: { description: LotDescription; aiAssisted: boolean; opening?: string }) => void;
  applied: boolean;
}) {
  const t = useTranslations('ai');
  const id = useId();
  const model = res.source === 'model';
  const [de, setDe] = useState(res.draft.descriptionDe);
  const [en, setEn] = useState(res.draft.descriptionEn);
  const [reviewed, setReviewed] = useState(false);
  const [useOpening, setUseOpening] = useState(false);
  const opening = res.draft.suggestedOpeningUsdc;

  return (
    <section className="ai-draft" aria-label={t('listing.result.heading')} data-testid="ai-draft" data-source={res.source}>
      <p className={`ai-badge ${model ? '' : 'ai-badge--template'}`} data-testid="ai-badge">{model ? t('badge.draft') : t('badge.template')}</p>
      {!model && <p className="ai-note">{t('listing.result.templateNote')}</p>}
      <dl className="ai-titles">
        <div><dt>{t('listing.result.titleDe')}</dt><dd data-testid="ai-title-de">{res.draft.titleDe}</dd></div>
        <div><dt>{t('listing.result.titleEn')}</dt><dd data-testid="ai-title-en">{res.draft.titleEn}</dd></div>
      </dl>
      <label htmlFor={`${id}-de`}>{t('listing.result.descDe')}</label>
      <textarea id={`${id}-de`} value={de} maxLength={1500} rows={5} onChange={(e) => setDe(e.target.value)} data-testid="ai-desc-de" />
      <label htmlFor={`${id}-en`}>{t('listing.result.descEn')}</label>
      <textarea id={`${id}-en`} value={en} maxLength={1500} rows={5} onChange={(e) => setEn(e.target.value)} data-testid="ai-desc-en" />
      {opening && (
        <div className="ai-opening" data-testid="ai-opening">
          <p>{t('listing.result.opening', { amount: formatUsdc(opening, locale).replace(' USDC', '') })} <span className="ai-note">{t('listing.result.openingNote')}</span></p>
          <label className="ai-check"><input type="checkbox" checked={useOpening} onChange={(e) => setUseOpening(e.target.checked)} data-testid="ai-use-opening" /> {t('listing.result.useOpening', { amount: formatUsdc(opening, locale).replace(' USDC', '') })}</label>
        </div>
      )}
      <label className="ai-check"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} data-testid="ai-reviewed" /> {t('listing.result.reviewed')}</label>
      <div className="ai-actions">
        <button type="button" className="ai-btn ai-btn--primary" disabled={!reviewed || !de.trim() || !en.trim()} onClick={() => onApply({ description: { de: de.trim(), en: en.trim() }, aiAssisted: model, ...(useOpening && opening ? { opening: baseToInput(opening) } : {}) })} data-testid="ai-apply">
          {t('listing.result.apply')}
        </button>
        {model && <span className="ai-note">{t('listing.result.left', { count: res.creditsLeft })}</span>}
      </div>
      {applied && <p className="ai-ok" role="status" data-testid="ai-applied">{t('listing.result.applied')}</p>}
    </section>
  );
}
