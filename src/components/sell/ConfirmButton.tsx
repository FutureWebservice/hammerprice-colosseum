'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/** A destructive action behind a second click. The first click only arms it; Escape or "No" disarms. */
export default function ConfirmButton({
  label, onConfirm, disabled, testId, danger = true,
}: { label: string; onConfirm: () => void; disabled?: boolean; testId?: string; danger?: boolean }) {
  const t = useTranslations('sell');
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return <button type="button" className="sl-btn" data-testid={testId} disabled={disabled} onClick={() => setArmed(true)}>{label}</button>;
  }
  return (
    <span className="sl-confirm" role="group" aria-label={label} onKeyDown={(e) => e.key === 'Escape' && setArmed(false)}>
      <button type="button" className={`sl-btn${danger ? ' sl-btn--danger' : ' sl-btn--primary'}`} data-testid={testId ? `${testId}-confirm` : undefined} autoFocus
        onClick={() => { setArmed(false); onConfirm(); }}>
        {t('manage.confirmYes', { action: label })}
      </button>
      <button type="button" className="sl-btn" onClick={() => setArmed(false)}>{t('manage.confirmNo')}</button>
    </span>
  );
}
