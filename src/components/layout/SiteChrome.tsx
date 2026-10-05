'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Header from './Header';
import Footer from './Footer';
import ExplainBubble from '@/components/explain/ExplainBubble';
import PitchRibbon from '@/components/pitch/PitchRibbon';

/**
 * Renders the site chrome around every page. The header is the SAME component everywhere, so the room does not
 * look like another site: inside /room/[id] it is the compact variant (56 px, sticky, same wordmark, links, Help,
 * language switcher, wallet and account entry), and the room's own status line (title, live or timed badge)
 * sits right under it, rendered by RoomShell. The footer and the pitch ribbon stay out of the room: a room fills
 * the screen and the only brass in it belongs to the bid slab; the room closes with its own slim row of legal
 * links (LegalLinkRow). The room INDEX at /rooms has the full chrome. No cookie banner: the only cookie
 * hammerprice sets is NEXT_LOCALE, which is functional and needs no consent.
 *
 * The skip link is the first Tab stop everywhere: on a page it jumps to the main content, in a room to the
 * bidding area. The explain bubble stays on every page, the room included: it is how the product explains
 * itself, so it cannot be the thing hidden where explanation is needed most.
 */
export default function SiteChrome({ children, pitchLabel, skipLabel = 'Skip to content', explainLabel = 'How it works' }: { children: React.ReactNode; pitchLabel: string; skipLabel?: string; explainLabel?: string }) {
  const pathname = usePathname();
  const inRoom = /\/room\//.test(pathname || '');
  const room = useTranslations('room');

  const skip = (
    <a
      href={inRoom ? '#ar-bidding' : '#main-content'}
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded focus:bg-[#C8A44D] focus:px-3 focus:py-2 focus:text-sm focus:text-[#221a08]"
      data-testid="skip-link"
    >
      {inRoom ? room('a11y.skip') : skipLabel}
    </a>
  );

  if (inRoom) {
    return (
      <>
        {skip}
        <Header compact />
        {children}
        <ExplainBubble label={explainLabel} />
      </>
    );
  }

  return (
    <>
      {skip}
      <Header />
      {children}
      <Footer />
      <PitchRibbon label={pitchLabel} />
      <ExplainBubble label={explainLabel} />
    </>
  );
}
