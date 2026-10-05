import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import VerifyRandom from '@/components/vrf/VerifyRandom';
import { isValidUuid } from '@/lib/uuid';

interface Params { params: Promise<{ locale: string; id: string }> }

export async function generateMetadata({ params }: Params) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'vrf' });
  return { title: `${t('page.title')} | Hammerprice`, description: t('page.lede'), robots: { index: false } };
}

/** /verify/random/[id]: the proof of one draw (the order of a show's lots, or its thank-you draw). The check runs in the browser. */
export default async function VerifyRandomPage({ params }: Params) {
  const { locale, id } = await params;
  if (!isValidUuid(id)) notFound();
  return <VerifyRandom id={id.toLowerCase()} locale={locale} />;
}
