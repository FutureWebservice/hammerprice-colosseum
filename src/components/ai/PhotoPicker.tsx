'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { shrinkImage, type Shrunk } from './image';

export const MAX_PHOTOS = 3;

/** Up to three photos, shrunk in the browser (no metadata, at most 1,280 px, under 600 KB) and kept in memory only. */
export default function PhotoPicker({ photos, onChange, disabled }: { photos: Shrunk[]; onChange: (p: Shrunk[]) => void; disabled?: boolean }) {
  const t = useTranslations('ai.listing');
  const input = useRef<HTMLInputElement>(null);
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBad(false); setBusy(true);
    let next = [...photos];
    for (const f of Array.from(files)) {
      if (next.length >= MAX_PHOTOS) break;
      try { next = [...next, await shrinkImage(f)]; } catch { setBad(true); }
    }
    setBusy(false);
    onChange(next);
    if (input.current) input.current.value = '';
  }

  return (
    <div className="ai-photos" data-testid="ai-photos">
      <ul className="ai-photo-list">
        {photos.map((p, i) => (
          <li key={p.previewUrl}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.previewUrl} alt="" width={72} height={72} />
            <button type="button" className="ai-x" aria-label={t('removePhoto')} onClick={() => { URL.revokeObjectURL(p.previewUrl); onChange(photos.filter((_, j) => j !== i)); }} disabled={disabled}>×</button>
          </li>
        ))}
      </ul>
      {photos.length < MAX_PHOTOS && (
        <>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void add(e.target.files)} data-testid="ai-photo-input" />
          <button type="button" className="ai-btn" onClick={() => input.current?.click()} disabled={disabled || busy}>{t('addPhoto')}</button>
        </>
      )}
      {bad && <p className="ai-err" role="alert">{t('photoBad')}</p>}
    </div>
  );
}
