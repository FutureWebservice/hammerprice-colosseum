import dynamic from 'next/dynamic';
import { notFound } from 'next/navigation';
import AuctionRoom from '@/components/auction/AuctionRoom';
import { DEMO_SHOW_ID } from '@/lib/demo-show';
import { getSolUsd } from '@/lib/sol-price';
import { getShowHead } from '@/lib/catalogue';
import { isValidUuid } from '@/lib/uuid';
import type { Locale } from '@/lib/i18n';
import { alternatesFor } from '@/components/landing/seo';

// The simulation lives in its own chunk: a real room never loads it.
const PracticeRoom = dynamic(() => import('@/components/auction/PracticeRoom'));

const DESCRIPTION: Record<Locale, string> = {
  en: 'A live auction room for graded cards. Every bid is signed, the lot closes by itself, and the winner pays in USDC on Solana in one co-signed transaction.',
  de: 'Ein Live-Auktionsraum für begutachtete Sammelkarten. Jedes Gebot ist unterschrieben, das Los schließt von selbst, und der Gewinner zahlt in USDC auf Solana in einer gemeinsam unterschriebenen Transaktion.',
};

// The house room is the one DEMO room; a link preview says so.
const DEMO_DESCRIPTION: Record<Locale, string> = {
  en: 'Demo room: replica cards owned by the platform. Labelled house bots bid in it but never outbid a person, and a bot win settles nothing.',
  de: 'Demo-Raum: Replik-Karten, die der Plattform gehören. Gekennzeichnete Haus-Bots bieten mit, überbieten aber nie eine Person, und ein Bot-Zuschlag wickelt nichts ab.',
};

const FALLBACK_TITLE: Record<Locale, string> = {
  en: 'Auction room',
  de: 'Auktionsraum',
};

// The room's own data (catalogue, snapshot, standing) is fetched by the browser, so this page is the same shell for everyone apart from the tab title and the
// SOL price. Rendered on the first visit of a show and then kept by the CDN for a minute (on demand: no show is known at build time), instead of one
// function call and two database reads per visitor. A stale title for up to a minute is the only difference.
export const revalidate = 60;
export function generateStaticParams() {
  return [];
}

interface Params {
  params: Promise<{ locale: Locale; id: string }>;
}

// An unknown or malformed id is a normal thing to land on (a stale link, a typo): the title falls back rather
// than failing, and the page itself answers 404.
export async function generateMetadata({ params }: Params) {
  const { locale, id } = await params;
  const result = isValidUuid(id) ? await getShowHead(id).catch(() => null) : null;
  const demo = result?.isHouse === true;
  const base = result?.title || FALLBACK_TITLE[locale] || FALLBACK_TITLE.en;
  const title = demo ? `${base} (Demo)` : base;
  const description = demo ? (DEMO_DESCRIPTION[locale] ?? DEMO_DESCRIPTION.en) : (DESCRIPTION[locale] ?? DESCRIPTION.en);
  return {
    title: `${title} | Hammerprice`,
    description,
    // The share image comes from this segment's opengraph-image file; the canonical and the hreflang pair are spelled out here.
    alternates: alternatesFor(locale === 'de' ? 'de' : 'en', `/room/${id}`),
    openGraph: { title: `${title} | Hammerprice`, description },
    twitter: { title: `${title} | Hammerprice`, description },
  };
}

export default async function RoomPage({ params }: Params) {
  const { id } = await params;
  if (!isValidUuid(id)) notFound();
  // One cached fetch per five minutes for the whole room, instead of a rate request from every browser. Null when
  // the feed is unreachable, and the room then shows USDC alone.
  const solUsd = await getSolUsd();
  return id === DEMO_SHOW_ID ? <PracticeRoom showId={id} solUsd={solUsd} /> : <AuctionRoom showId={id} solUsd={solUsd} />;
}
