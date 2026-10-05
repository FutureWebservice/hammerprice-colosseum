import AboutPage, { aboutMetadata } from '@/components/explain/AboutPage';
import { vaultTotal } from '@/components/pitch/vault-total';
import { houseProofHref } from '@/components/pitch/proof-link';
import { defaultLocale, isLocale, locales } from '@/lib/i18n/config';

// The page carries the vault's own count and the newest house proof, read at revalidate time.
export const revalidate = 300;

export const generateStaticParams = () => locales.map((locale) => ({ locale }));

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  return aboutMetadata((await params).locale);
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const [total, proofHref] = await Promise.all([vaultTotal(isLocale(locale) ? locale : defaultLocale), houseProofHref()]);
  return <AboutPage locale={locale} total={total} proofHref={proofHref} />;
}
