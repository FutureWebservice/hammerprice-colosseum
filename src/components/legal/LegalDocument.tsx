/** @jsxRuntime automatic @jsxImportSource react */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Locale } from '@/lib/i18n/config';
import { isSafeHref, type Block, type Inline } from '@/legal/markdown';
import { rewriteLegalLink } from '@/legal/routes';

/**
 * Turns parsed legal markdown into elements. Everything goes through React's escaping: no raw
 * HTML is injected, and only `/path`, `https:` and `mailto:` targets become links.
 */
function href(locale: Locale, raw: string): string | null {
  if (!isSafeHref(raw)) return null;
  if (raw.startsWith('/')) return rewriteLegalLink(locale, raw) ?? `/${locale}${raw}`;
  return raw;
}

function Inlines({ nodes, locale }: { nodes: Inline[]; locale: Locale }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'strong': return <strong key={i}><Inlines nodes={n.children} locale={locale} /></strong>;
      case 'em': return <em key={i}><Inlines nodes={n.children} locale={locale} /></em>;
      case 'code': return <code key={i}>{n.v}</code>;
      case 'link': {
        const h = href(locale, n.href);
        if (!h) return n.text;
        return h.startsWith('/') ? (
          <Link key={i} href={h}>{n.text}</Link>
        ) : (
          <a key={i} href={h} rel="noopener noreferrer">{n.text}</a>
        );
      }
    }
  });
}

export default function LegalDocument({ blocks, locale }: { blocks: Block[]; locale: Locale }) {
  return (
    <div className="lg-doc">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const H = `h${b.level}` as 'h1' | 'h2' | 'h3' | 'h4';
            return <H key={i}><Inlines nodes={b.inline} locale={locale} /></H>;
          }
          case 'p':
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    <Inlines nodes={l} locale={locale} />
                  </span>
                ))}
              </p>
            );
          case 'ul':
          case 'ol': {
            const L = b.t;
            return <L key={i}>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} locale={locale} /></li>)}</L>;
          }
          case 'table':
            return (
              <div key={i} className="lg-table-wrap" tabIndex={0} role="region" aria-label={`${locale === 'de' ? 'Tabelle' : 'Table'} ${blocks.slice(0, i + 1).filter((x) => x.t === 'table').length}`}>
                <table>
                  <thead><tr>{b.head.map((c, j) => <th key={j} scope="col"><Inlines nodes={c} locale={locale} /></th>)}</tr></thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, k) => <td key={k}><Inlines nodes={c} locale={locale} /></td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
