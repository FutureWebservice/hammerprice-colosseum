import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import ManagePacks from '@/components/packs/ManagePacks';
import { featureEnv } from '@/lib/features';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'packs' });
  return { title: t('meta.manageTitle'), robots: { index: false } };
}

export default async function ManagePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!featureEnv('PACKS')) notFound();
  setRequestLocale(locale);
  return <ManagePacks locale={locale === 'de' ? 'de' : 'en'} />;
}
