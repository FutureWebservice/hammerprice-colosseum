/** @jsxRuntime automatic @jsxImportSource react */
import Link from 'next/link';
import type { Locale } from '@/lib/i18n/config';
import { loadLegalDoc, legalTitles } from '@/legal/content';
import { legalPath, type LegalKey } from '@/legal/routes';
import de from '@/locales/de/legal.json';
import en from '@/locales/en/legal.json';
import LegalDocument from './LegalDocument';
import './legal.css';

const UI = { de: de.ui, en: en.ui } as const;

/** One legal page: kicker, the rendered text, and a row to the other legal pages. Server component. */
export default function LegalPage({ locale, docKey }: { locale: Locale; docKey: LegalKey }) {
  const doc = loadLegalDoc(locale, docKey);
  const ui = UI[locale];
  return (
    <article className="lg-page">
      <div className="lg-wrap">
        <p className="lg-kicker">
          {docKey === 'index' ? 'Hammerprice' : <Link href={legalPath(locale, 'index')}>{ui.kicker}</Link>}
        </p>
        <div className="lg-rule" />
        <LegalDocument blocks={doc.blocks} locale={locale} />
        {docKey !== 'index' && (
          <nav className="lg-nav" aria-label={ui.navLabel}>
            <p className="lg-nav-label">{ui.navLabel}</p>
            <ul>
              {legalTitles(locale).filter((t) => t.key !== 'index').map((t) => (
                <li key={t.key}>
                  <Link href={legalPath(locale, t.key)} aria-current={t.key === docKey ? 'page' : undefined}>{t.title}</Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </article>
  );
}
