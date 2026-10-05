/**
 * The default social preview: what a link to Hammerprice looks like pasted into Slack, X or a judge's
 * chat. One static card for the whole site (no locale segment exists up here), so it carries the
 * headline in both languages. The brand faces come from assets/fonts (see components/landing/og.tsx),
 * never from a font CDN. Room pages get their own card from the room route.
 */
import { ogImage, SITE_HOST } from '@/components/landing/og';

export const alt = 'Hammerprice. The hammer is the payment. Der Hammer ist die Zahlung.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return ogImage({
    kicker: 'LIVE AUCTIONS FOR GRADED CARDS',
    headline: 'The hammer is the payment.',
    headline2: 'Der Hammer ist die Zahlung.',
    deck: 'USDC to the seller, the card to the buyer, in one transaction.',
    badge: 'LIVE BETA',
    footerLeft: SITE_HOST,
    footerRight: 'USDC ON SOLANA',
  });
}
