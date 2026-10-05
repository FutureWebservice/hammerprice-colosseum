'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDialog } from '@/hooks/room/useDialog';
import { ChatError, errorKey, reportMessage, type ReportReason } from './chatClient';

const REASONS: ReportReason[] = ['spam', 'scam', 'harassment', 'illegal', 'other'];

/** Report one public message. A viewer without a session is pointed to the contact page instead (the report route needs a session). */
export default function ReportDialog({ messageId, signedIn, locale, onClose }: { messageId: string; signedIn: boolean; locale: string; onClose: () => void }) {
  const t = useTranslations('chat');
  const ref = useDialog<HTMLDivElement>(onClose);
  const [reason, setReason] = useState<ReportReason>('spam');
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setState('busy');
    setError(null);
    try {
      await reportMessage(messageId, reason, detail.trim() || undefined);
      setState('done');
    } catch (e) {
      setState('idle');
      setError(t(`error.${errorKey(e instanceof ChatError ? e : null)}`));
    }
  };

  return (
    <>
      <div className="hp-sheet-backdrop" onClick={onClose} />
      <div ref={ref} data-testid="report-dialog" className="hp-sheet hc-report" role="dialog" aria-modal="true" aria-labelledby="hc-report-title" tabIndex={-1}>
        <div className="hp-sheet-head">
          <h2 id="hc-report-title" className="hp-sheet-title">{t('report.title')}</h2>
          <button type="button" className="hp-sheet-close" onClick={onClose} aria-label={t('report.close')}>×</button>
        </div>
        {state === 'done' ? (
          <p className="hp-sheet-text">{t('report.thanks')}</p>
        ) : !signedIn ? (
          <p className="hp-sheet-text">
            {t('report.signIn')}{' '}
            <a className="hp-inline-link" href={`/${locale}/legal/dsa-contact`}>{t('report.contact')}</a>
          </p>
        ) : (
          <>
            <p className="hp-sheet-text">{t('report.text')}</p>
            <label className="hp-field">
              {t('report.reasonLabel')}
              <select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
                {REASONS.map((r) => <option key={r} value={r}>{t(`report.reasons.${r}`)}</option>)}
              </select>
            </label>
            <label className="hp-field">
              {t('report.detailLabel')}
              <textarea value={detail} maxLength={500} rows={3} onChange={(e) => setDetail(e.target.value)} />
            </label>
            {error && <p className="hp-sheet-error" role="alert">{error}</p>}
            <div className="hp-sheet-actions">
              <button type="button" className="hp-sheet-secondary" onClick={onClose}>{t('mod.cancel')}</button>
              <button type="button" className="hp-sheet-primary" disabled={state === 'busy'} onClick={() => void submit()}>{t('report.submit')}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
