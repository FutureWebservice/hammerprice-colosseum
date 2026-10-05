import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import BroadcastPage from '@/components/streaming/BroadcastPage';
import { broadcastMetadata } from '@/components/streaming/metadata';
import { isValidUuid } from '@/lib/uuid';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  return broadcastMetadata((await params).locale);
}

export default async function BroadcastRoute({ params }: { params: Promise<{ locale: string; showId: string }> }) {
  const { locale, showId } = await params;
  setRequestLocale(locale);
  if (!isValidUuid(showId)) notFound();
  return <BroadcastPage showId={showId} />;
}
