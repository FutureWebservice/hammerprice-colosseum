/** /verify/packs/[id]: the proof of one pack opening, recomputed in the visitor's browser. Behind FEATURE_PACKS like the pack pages. */
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import ProofView from '@/components/packs/ProofView';
import { featureEnv } from '@/lib/features';
import { isValidUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

interface Params { params: Promise<{ locale: string; id: string }> }

export async function generateMetadata({ params }: Params) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'packs' });
  return { title: t('meta.proofTitle'), description: t('proof.lede'), robots: { index: false } };
}

export default async function PackProofPage({ params }: Params) {
  const { locale, id } = await params;
  if (!featureEnv('PACKS') || !isValidUuid(id)) notFound();
  setRequestLocale(locale);
  return <ProofView drawId={id.toLowerCase()} locale={locale === 'de' ? 'de' : 'en'} />;
}
