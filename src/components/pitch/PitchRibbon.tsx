'use client';

/**
 * The brass ribbon down the right edge: one permanent way into the pitch section of the About page (/about#pitch), from wherever a reader
 * happens to be.
 *
 * A hackathon judge arrives at the landing page and has to find two things - the document that
 * explains the idea, and the product itself. The landing already sends them into the room. This
 * is the other half, and it is a ribbon rather than a button because that is what a sale
 * catalogue actually has: a silk marker hanging out of the page edge at the place you meant to
 * come back to.
 *
 * Deliberately NOT in the room. In there the only brass belongs to the bid slab, and a second
 * gold thing competing for the same glance would cost more than this link is worth. SiteChrome
 * mounts it only on the chromed pages, and it hides itself on /about, where the pitch is one scroll away
 * in the page you are standing on.
 *
 * Below 900px it hides too: a vertical edge tab on a phone lands on the content and fights the
 * explain bubble for the same corner. The nav item and the footer link carry it there.
 */
import { usePathname } from 'next/navigation';
import { Link } from '@/lib/i18n';
import './ribbon.css';

export default function PitchRibbon({ label }: { label: string }) {
  const pathname = usePathname() || '';
  if (/\/about(\/|$)/.test(pathname)) return null;

  return (
    <aside aria-label={label}>
      <Link href="/about#pitch" className="pt-ribbon">
        <span className="pt-ribbon-text">{label}</span>
      </Link>
    </aside>
  );
}
