/** @jsxRuntime automatic @jsxImportSource react */
'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import { legalHref, type LegalKey } from '@/legal/routes';
import type { Locale } from '@/lib/i18n/config';

/** The pages a bidder must be able to reach from anywhere (B10). The room has no footer, so it mounts this row. */
const ROOM_ROW: readonly LegalKey[] = ['impressum', 'datenschutz', 'terms', 'fees', 'risk'];

/** One quiet line of legal links. Labels come from footer.json, the same ones the footer uses. */
export default function LegalLinkRow({ keys = ROOM_ROW, className = '' }: { keys?: readonly LegalKey[]; className?: string }) {
  const t = useTranslations('footer');
  const locale = useLocale() as Locale;
  return (
    <nav aria-label={t('legalNav')} className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#9AA3B2] ${className}`}>
      {keys.map((k) => (
        <Link key={k} href={legalHref(locale, k)} prefetch={false} className="transition-colors duration-200 hover:text-[#F4F0E6]">
          {t(`legal.${k}`)}
        </Link>
      ))}
    </nav>
  );
}
