/**
 * /packs: the packs on sale. Behind FEATURE_PACKS (a switched-off feature is a 404, as if the page did not exist). Dynamic on purpose: the
 * switch is read from the running environment, not frozen at build time.
 */
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import PacksIndex from '@/components/packs/PacksIndex';
import { featureEnv } from '@/lib/features';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'packs' });
  return { title: t('meta.title'), description: t('meta.description') };
}

export default async function PacksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!featureEnv('PACKS')) notFound();
  setRequestLocale(locale);
  return <PacksIndex locale={locale === 'de' ? 'de' : 'en'} />;
}
