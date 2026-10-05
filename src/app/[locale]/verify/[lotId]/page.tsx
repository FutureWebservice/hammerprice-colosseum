import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import VerifyLot from '@/components/room/VerifyLot';
import { isValidUuid } from '@/lib/uuid';

interface Params { params: Promise<{ locale: string; lotId: string }> }

export async function generateMetadata({ params }: Params) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'settlement' });
  const title = `${t('verify.title')} | Hammerprice`;
  return { title, description: t('verify.lede'), robots: { index: false } };
}

export default async function VerifyPage({ params }: Params) {
  const { locale, lotId } = await params;
  if (!isValidUuid(lotId)) notFound();
  // Ask the database first: a lot that does not exist is a normal landing (a stale or mistyped link) and should not fire a failing request.
  const { db, lots } = await import('@/db');
  const { eq } = await import('drizzle-orm');
  const found = await db.select({ id: lots.id }).from(lots).where(eq(lots.id, lotId.toLowerCase())).limit(1).catch(() => null);
  return <VerifyLot lotId={lotId} locale={locale} known={found === null || found.length > 0} />;
}
