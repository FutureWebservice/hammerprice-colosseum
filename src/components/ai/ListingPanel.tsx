'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LotDescription } from '@/contracts';
import { parseUsdc } from '@/components/sell/money';
import type { LotDraft } from '@/components/sell/wizardState';
import { AiCallError, errorKey, postListing } from './client';
import CreditsBar from './CreditsBar';
import DraftView from './DraftView';
import PhotoPicker from './PhotoPicker';
import type { Shrunk } from './image';
import type { Credits } from './useAiCredits';
import './ai.css';

type Res = Awaited<ReturnType<typeof postListing>>;

/**
 * The AI listing draft in the sell wizard: pick a card, optionally add your own estimate, notes and up to three photos, create the draft
 * (one credit; a free template when no model is set up), review it, adopt it. Every AI text is labelled and adopted only by the seller.
 */
export default function ListingPanel({ lots, locale, credits, onCredits, onApply }: {
  lots: LotDraft[];
  locale: string;
  credits: Credits;
  onCredits: (balance: number) => void;
  onApply: (mint: string, patch: { description: LotDescription; aiAssisted: boolean; opening?: string }) => void;
}) {
  const t = useTranslations('ai');
  const [mint, setMint] = useState(lots[0]?.mint ?? '');
  const [estimate, setEstimate] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<Shrunk[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Res | null>(null);
  const [applied, setApplied] = useState(false);

  const lot = lots.find((l) => l.mint === mint) ?? lots[0];
  if (!lot) return null;
  const parsedEstimate = estimate.trim() === '' ? null : parseUsdc(estimate);
  const estimateBad = parsedEstimate !== null && !parsedEstimate.ok;
  const free = !credits.configured; // no model set up: templates only, no credit involved
  const noCredit = !free && credits.free !== true && credits.balance < 1; // AI_FREE: no credit is needed
  const lang: 'de' | 'en' = locale.startsWith('de') ? 'de' : 'en';

  async function create() {
    setBusy(true); setErr(null); setApplied(false);
    try {
      const body = {
        requestId: crypto.randomUUID(),
        fields: { name: lot!.name.slice(0, 120), ...(lot!.grade ? { grade: lot!.grade.slice(0, 20) } : {}), ...(notes.trim() ? { notes: notes.trim().slice(0, 600) } : {}), ...(parsedEstimate?.ok ? { estimateUsdc: parsedEstimate.base } : {}), locale: lang },
        ...(photos.length && !free ? { images: photos.map((p) => ({ mediaType: p.mediaType, dataBase64: p.dataBase64 })) } : {}),
      };
      const r = await postListing(body);
      setRes(r);
      if (!free) onCredits(r.creditsLeft);
    } catch (e) {
      if (e instanceof AiCallError && e.code === 'payment_required') { onCredits(0); setErr('credits.none'); }
      else setErr(errorKey(e, 'listing'));
    } finally { setBusy(false); }
  }

  return (
    <details className="ai-panel" data-testid="ai-listing">
      <summary>{t('listing.title')}</summary>
      <div className="ai-body">
        <p className="ai-note">{t('listing.intro')}</p>
        <CreditsBar credits={credits} onBought={onCredits} />
        {lots.length > 1 && (
          <label className="ai-field">{t('listing.card')}
            <select value={lot.mint} onChange={(e) => { setMint(e.target.value); setRes(null); }} data-testid="ai-card">{lots.map((l) => <option key={l.mint} value={l.mint}>{l.name}</option>)}</select>
          </label>
        )}
        <p className="ai-used">{t('listing.usedForCard', { name: lot.name })}</p>
        <label className="ai-field">{t('listing.estimate')}
          <input inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} aria-invalid={estimateBad} data-testid="ai-estimate" />
        </label>
        <p className="ai-note">{t('listing.estimateHint')}</p>
        <label className="ai-field">{t('listing.notes')}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={600} rows={3} data-testid="ai-notes" />
        </label>
        <p className="ai-note">{t('listing.notesHint')}</p>
        {!free && (
          <>
            <p className="ai-label">{t('listing.photos')}</p>
            <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />
            <p className="ai-note">{t('listing.photosHint')}</p>
          </>
        )}
        <div className="ai-actions">
          <button type="button" className="ai-btn ai-btn--primary" onClick={() => void create()} disabled={busy || estimateBad || noCredit} data-testid="ai-create">
            {busy ? t('listing.creating') : free ? t('listing.createTemplate') : t('listing.create')}
          </button>
        </div>
        {err && <p className="ai-err" role="alert" data-testid="ai-error">{t(err)}</p>}
        {res && <DraftView key={`${res.draft.titleEn}|${res.creditsLeft}`} res={res} locale={locale} applied={applied} onApply={(p) => { onApply(lot.mint, p); setApplied(true); }} />}
      </div>
    </details>
  );
}
