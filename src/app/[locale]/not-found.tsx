'use client';

/**
 * The 404 inside the site: header, footer and language of the visitor stay, the page says what happened and offers the two ways on.
 * A client component on purpose: it reads the messages the layout already gave the provider, so it needs no request locale of its own.
 * (An address that matches no route at all is caught by [...rest]/page.tsx, which calls notFound(), so it ends up here too.)
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import StatePanel, { SP_ALT, SP_PRIMARY } from '@/components/ui/StatePanel';

export default function LocaleNotFound() {
  const t = useTranslations('common.states');
  return (
    <StatePanel kicker={t('notFound.kicker')} title={t('notFound.title')} testId="not-found" actions={<>
      <Link href="/rooms" className={SP_PRIMARY}>{t('rooms')}</Link>
      <Link href="/" className={SP_ALT}>{t('home')}</Link>
    </>}>
      {t('notFound.body')}
    </StatePanel>
  );
}
