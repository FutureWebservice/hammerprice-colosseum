'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ApiFail } from './api';
import { formatWait } from './datetime';

/**
 * The words for an API failure: the `sell.errors.<code>` message, `generic` when we have none, and for a
 * rate limit the wait the server asked for. The server's own `reason` is shown by callers that want detail.
 */
export function useApiError() {
  const t = useTranslations('sell');
  const locale = useLocale();
  return (f: Pick<ApiFail, 'code' | 'retryAfterS'>): string => {
    const key = `errors.${f.code}`;
    const base = t.has(key) ? t(key) : t('errors.generic');
    return f.retryAfterS ? `${base} ${t('errors.retryIn', { wait: formatWait(f.retryAfterS, locale) })}` : base;
  };
}

/** The words for one readiness reason. `standard` names the card's token standard for the `unsupported_standard` message. */
export function useReasonText() {
  const t = useTranslations('sell');
  return (reason: string, standard: string = 'unknown') => t(`reasons.${reason}`, { standard: t(`standards.${standard}`) });
}
