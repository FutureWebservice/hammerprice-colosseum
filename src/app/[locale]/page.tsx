/**
 * The homepage.
 *
 * HammerpriceLanding is a server component that resolves its copy from src/locales/{de,en}
 * /landing.json, so this page's job is reading the locale off params, handing it down, and
 * emitting the site's structured data (Organization and WebSite, once, on the home page).
 */
import HammerpriceLanding from '@/components/landing/HammerpriceLanding';
import JsonLd from '@/components/landing/JsonLd';
import { organizationJsonLd, pageMetadata, websiteJsonLd } from '@/components/landing/seo';
import type { Locale } from '@/lib/i18n';

export const revalidate = 300;

// Kept here rather than in landing.json: this is the one piece of the homepage's copy a
// search result or a share card shows, not the page itself, and it changes on a different
// schedule than the on-page hero copy that file owns.
const META: Record<Locale, { title: string; description: string }> = {
  en: {
    title: 'Hammerprice: live auctions for graded cards, settled in USDC on Solana',
    description:
      'A live auction room for graded cards. The winning bid pays the seller in USDC and moves the ' +
      'card to the buyer in one Solana transaction.',
  },
  de: {
    title: 'Hammerprice: Live-Auktionen für gradierte Karten, abgewickelt in USDC auf Solana',
    description:
      'Ein Live-Auktionsraum für gradierte Sammelkarten. Das Siegergebot zahlt dem Verkäufer USDC und ' +
      'überträgt die Karte an den Käufer, in einer Solana-Transaktion.',
  },
};

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const copy = META[locale] ?? META.en;
  return pageMetadata({ locale: META[locale] ? locale : 'en', path: '/', title: copy.title, description: copy.description });
}

export default async function HomePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  return (
    <>
      <JsonLd data={organizationJsonLd()} />
      <JsonLd data={websiteJsonLd()} />
      <HammerpriceLanding locale={locale} />
    </>
  );
}
