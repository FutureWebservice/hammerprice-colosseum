/**
 * The share card for one room: its title and its first lot, in the visitor's language. An unknown id still gets
 * the generic room card (a link preview must never 500). Built with the same helper as the site card.
 */
import { ogImage, SITE_HOST } from '@/components/landing/og';
import { getShowWithLots } from '@/lib/catalogue';
import { isValidUuid } from '@/lib/uuid';

export const alt = 'Hammerprice auction room';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const COPY = {
  en: { kicker: 'LIVE AUCTION ROOM', demoKicker: 'DEMO ROOM', demoDeck: 'Replica cards and labelled bots that never outbid a person.', fallback: 'Auction room', lots: (n: number) => `${n} ${n === 1 ? 'lot' : 'lots'}`, first: 'First lot', deck: 'Every bid signed. USDC to the seller, the card to the buyer, in one transaction.', right: 'USDC ON SOLANA' },
  de: { kicker: 'LIVE-AUKTIONSRAUM', demoKicker: 'DEMO-RAUM', demoDeck: 'Replik-Karten und gekennzeichnete Bots, die nie eine Person überbieten.', fallback: 'Auktionsraum', lots: (n: number) => `${n} ${n === 1 ? 'Los' : 'Lose'}`, first: 'Erstes Los', deck: 'Jedes Gebot unterschrieben. USDC an den Verkäufer, die Karte an den Käufer, in einer Transaktion.', right: 'USDC AUF SOLANA' },
} as const;

export default async function Image({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const c = COPY[locale === 'de' ? 'de' : 'en'];
  const data = isValidUuid(id) ? await getShowWithLots(id).catch(() => null) : null;
  const first = data?.lots[0]?.name;
  const demo = data?.show.isHouse === true; // the house room is the one DEMO room: the card says so
  return ogImage({
    kicker: data ? `${demo ? c.demoKicker : c.kicker} · ${c.lots(data.lots.length).toUpperCase()}` : c.kicker,
    headline: clip(data?.show.title ?? c.fallback, 56),
    deck: demo ? c.demoDeck : first ? `${c.first}: ${clip(first, 70)}` : c.deck,
    badge: demo ? 'DEMO' : undefined,
    footerLeft: SITE_HOST,
    footerRight: c.right,
  });
}
