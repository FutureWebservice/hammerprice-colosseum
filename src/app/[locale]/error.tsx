'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import StatePanel, { SP_ALT, SP_PRIMARY } from '@/components/ui/StatePanel';

/**
 * The fallback for any render error below the locale layout: a short, honest, branded page instead of the framework's bare "Application error".
 * The layout (and with it the messages and the header) is still standing, so the text comes from the visitor's language.
 */
export default function LocaleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('common.states');
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <StatePanel kicker={t('error.kicker')} title={t('error.title')} role="alert" testId="error-page" actions={<>
      <button type="button" onClick={reset} className={SP_PRIMARY}>{t('retry')}</button>
      <Link href="/rooms" className={SP_ALT}>{t('rooms')}</Link>
      <Link href="/" className={SP_ALT}>{t('home')}</Link>
    </>}>
      {t('error.body')}
    </StatePanel>
  );
}
