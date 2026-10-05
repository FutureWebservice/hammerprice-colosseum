import { getTranslations, setRequestLocale } from 'next-intl/server';
import SellHome from '@/components/sell/SellHome';
import { featureEnv } from '@/lib/features';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'sell' });
  return { title: t('meta.title'), description: t('meta.description'), robots: { index: false } };
}

export default async function SellPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <SellHome packs={featureEnv('PACKS')} />;
}
