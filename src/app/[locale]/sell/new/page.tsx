import { getTranslations, setRequestLocale } from 'next-intl/server';
import Wizard from '@/components/sell/Wizard';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'sell' });
  return { title: t('wizard.meta'), robots: { index: false } };
}

export default async function NewShowPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Wizard />;
}
