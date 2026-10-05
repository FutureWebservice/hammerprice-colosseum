/** A link that is an in-page anchor (`#verify`) as a plain <a>, and a page of the site (`/rooms`) through the locale-aware Link. */
import { Link, type Locale } from '@/lib/i18n';

export default function Go({ href, locale, className, children }: { href: string; locale: Locale; className?: string; children: React.ReactNode }) {
  return href.startsWith('#') ? (
    <a href={href} className={className}>{children}</a>
  ) : (
    <Link href={href} locale={locale} className={className}>{children}</Link>
  );
}
