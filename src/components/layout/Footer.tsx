/** @jsxRuntime automatic @jsxImportSource react */
'use client';

import { Link } from '@/lib/i18n';
import { packsNavOn } from '@/lib/client/features';
import { useLocale, useTranslations } from 'next-intl';
import { OPERATOR, NETWORK_MODE } from '@/legal/config';
import { legalHref, type LegalKey } from '@/legal/routes';
import type { Locale } from '@/lib/i18n/config';
import Logo from '@/components/brand/Logo';

// The faces are self-hosted by next/font in [locale]/layout.tsx and exposed as CSS variables.
const MONO_STACK = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace';
const linkClass = 'inline-block px-1 py-1 text-[#9AA3B2] hover:text-[#F4F0E6] transition-colors duration-200';

/** SPEC 3: Impressum, privacy, terms, cookies first; then the notices a bidder may want. The last link is the hub, which lists them all. */
const LEGAL_ROW: readonly LegalKey[] = ['impressum', 'datenschutz', 'terms', 'cookies', 'consumer', 'risk', 'fees', 'dsa-contact', 'index'];

/**
 * One quiet footer, not a sitemap. Hammerprice is an MVP presenting a finished product for a
 * hackathon, so there is no column of links to features that do not exist. What belongs here: the
 * wordmark, what the product is in one sentence, a way to understand it, every legal page (the
 * Impressum must be reachable from every page), the demonstration notice while on the test network,
 * the one contact mailbox, and what this was built for. The room hides this footer and mounts
 * LegalLinkRow instead.
 */
export default function Footer() {
  const t = useTranslations('footer');
  const tn = useTranslations('nav');
  const items = [['/', 'home'], ['/rooms', 'rooms'], ['/sell', 'sell'], ['/account', 'profile'], ['/ai', 'ai'], ...(packsNavOn() ? [['/packs', 'packs']] : []), ['/about', 'about']] as const; // the same items, in the same order, as the header bar
  const locale = useLocale() as Locale;
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-[#0E1116] border-t border-[#C8A44D]/25">
      <div className="container mx-auto px-4 py-10">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div>
            <Logo variant="tagline" className="h-14 w-auto max-w-full" />
            <p className="text-sm text-[#F4F0E6]/70 mt-3 max-w-md">{t('tagline')}</p>
          </div>

          <nav className="flex flex-wrap items-center gap-x-6 gap-y-1" style={{ fontFamily: MONO_STACK }}>
            {items.map(([href, key]) => (
              <Link key={key} href={href} prefetch={false} className={`text-[11px] uppercase tracking-[0.08em] ${linkClass}`}>
                {tn(key)}
              </Link>
            ))}
          </nav>
        </div>

        <nav aria-label={t('legalNav')} className="mt-8 flex flex-wrap gap-x-5 gap-y-2" style={{ fontFamily: MONO_STACK }}>
          {LEGAL_ROW.map((k) => (
            <Link key={k} href={legalHref(locale, k)} prefetch={false} className={`text-[11px] ${linkClass}`}>
              {t(`legal.${k}`)}
            </Link>
          ))}
        </nav>

        <div className="border-t border-[#C8A44D]/15 mt-8 pt-6 space-y-2">
          <p className="text-xs text-[#9AA3B2]" style={{ fontFamily: MONO_STACK }}>
            &copy; {currentYear} HAMMERPRICE, {OPERATOR.name}.{' '}
            <a href={`mailto:${OPERATOR.email}`} className={linkClass}>{OPERATOR.email}</a>
          </p>
          <p className="text-xs text-[#9AA3B2]" style={{ fontFamily: MONO_STACK }}>{t('context')}</p>
          {/* Gone by itself on mainnet: the one switch (SOLANA_CLUSTER, inlined as NEXT_PUBLIC_SOLANA_NETWORK). */}
          {NETWORK_MODE !== 'mainnet' && <p className="text-xs text-[#9AA3B2]" style={{ fontFamily: MONO_STACK }} data-testid="footer-demo">{t('demo')}</p>}
        </div>
      </div>
    </footer>
  );
}
