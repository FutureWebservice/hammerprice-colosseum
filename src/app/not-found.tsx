/**
 * The 404 for an address outside every language (an address under /en or /de is caught by [locale]/not-found.tsx and keeps the header and
 * footer). The root layout renders no document (the locale layout owns <html>), so this page brings its own. It sits outside the locale tree,
 * which is why it says the one thing in both languages instead of reading messages. Same look as StatePanel: the logo symbol, serif headline, solid
 * brass primary button.
 */
import Link from 'next/link';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const btn = { display: 'inline-block', padding: '13px 26px', fontFamily: MONO, fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none', borderRadius: 2, border: '1px solid #C8A44D' } as const;

export default function NotFound() {
  return (
    <html lang="en">
      <head>
        <title>404 | Hammerprice</title>
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#0E1116" />
        <link rel="icon" href="/favicon.ico?v=2" sizes="48x48" />
        <link rel="icon" href="/icons/icon.svg?v=2" type="image/svg+xml" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
      </head>
      <body style={{ margin: 0, background: '#0E1116', color: '#F4F0E6', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <div style={{ maxWidth: 640 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a small SVG file, decorative */}
            <img src="/brand/logo-symbol.svg" alt="" width={31} height={44} style={{ display: 'block', width: 'auto', height: 44, marginBottom: 22 }} />
            <p style={{ margin: '0 0 14px', fontFamily: MONO, fontSize: 11, letterSpacing: '0.16em', color: '#C8A44D' }}>404</p>
            <h1 style={{ margin: '0 0 14px', fontFamily: 'Georgia, ui-serif, serif', fontWeight: 400, fontSize: 'clamp(40px, 8vw, 68px)', lineHeight: 1, letterSpacing: '-0.02em' }}>This page does not exist.</h1>
            <p style={{ margin: '0 0 6px', color: '#C9D1CD', fontSize: 17 }}>Diese Seite gibt es nicht.</p>
            <p style={{ margin: '0 0 28px', color: '#C9D1CD', fontSize: 17 }}>The rooms are the best place to pick up again. / In den Räumen machen Sie am besten weiter.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 14px' }}>
              <Link href="/en/rooms" style={{ ...btn, background: '#C8A44D', color: '#0E1116' }}>Rooms</Link>
              <Link href="/de/rooms" style={{ ...btn, background: 'transparent', color: '#E8C776', borderColor: 'rgba(232, 199, 118, 0.7)' }}>Räume</Link>
              <Link href="/en" style={{ ...btn, background: 'transparent', color: '#E8C776', borderColor: 'rgba(232, 199, 118, 0.7)' }}>Home</Link>
              <Link href="/de" style={{ ...btn, background: 'transparent', color: '#E8C776', borderColor: 'rgba(232, 199, 118, 0.7)' }}>Startseite</Link>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
