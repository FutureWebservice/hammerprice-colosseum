import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import PackPage from '@/components/packs/PackPage';
import { featureEnv } from '@/lib/features';
import { isValidUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

interface Params { params: Promise<{ locale: string; id: string }> }

export async function generateMetadata({ params }: Params) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'packs' });
  return { title: t('meta.title'), description: t('meta.description'), robots: { index: false } };
}

export default async function PackDetailPage({ params }: Params) {
  const { locale, id } = await params;
  if (!featureEnv('PACKS') || !isValidUuid(id)) notFound();
  setRequestLocale(locale);
  return <PackPage packId={id.toLowerCase()} locale={locale === 'de' ? 'de' : 'en'} />;
}
