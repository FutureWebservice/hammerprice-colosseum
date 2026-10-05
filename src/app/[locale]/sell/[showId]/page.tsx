import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import Manage from '@/components/sell/Manage';
import { isValidUuid } from '@/lib/uuid';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'sell' });
  return { title: t('manage.meta'), robots: { index: false } };
}

export default async function ManageShowPage({ params }: { params: Promise<{ locale: string; showId: string }> }) {
  const { locale, showId } = await params;
  setRequestLocale(locale);
  if (!isValidUuid(showId)) notFound();
  return <Manage showId={showId} />;
}
