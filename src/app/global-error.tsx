'use client';

/**
 * The last resort: an error in the root or the locale layout itself, where no message, no header and no stylesheet is available. It brings its
 * own document, says the one thing in both languages and offers a retry and a way home. (Any error below the layout is handled by
 * [locale]/error.tsx, which keeps the header and the visitor's language.)
 */
import { useEffect } from 'react';
import Link from 'next/link';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const btn = { display: 'inline-block', padding: '13px 26px', fontFamily: MONO, fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none', borderRadius: 2, border: '1px solid #C8A44D', cursor: 'pointer' } as const;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <head><title>Hammerprice</title></head>
      <body style={{ margin: 0, background: '#0E1116', color: '#F4F0E6', fontFamily: 'system-ui, sans-serif' }}>
        <main role="alert" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <div style={{ maxWidth: 640 }}>
            <div style={{ width: 68, height: 2, background: '#C8A44D', marginBottom: 22 }} />
            <p style={{ margin: '0 0 14px', fontFamily: MONO, fontSize: 11, letterSpacing: '0.16em', color: '#C8A44D' }}>ERROR / FEHLER</p>
            <h1 style={{ margin: '0 0 14px', fontFamily: 'Georgia, ui-serif, serif', fontWeight: 400, fontSize: 'clamp(36px, 7vw, 60px)', lineHeight: 1.02, letterSpacing: '-0.02em' }}>This page failed to load.</h1>
            <p style={{ margin: '0 0 6px', color: '#C9D1CD', fontSize: 17 }}>Please try again. If it keeps happening, come back in a moment.</p>
            <p style={{ margin: '0 0 28px', color: '#C9D1CD', fontSize: 17 }}>Diese Seite konnte nicht geladen werden. Bitte versuchen Sie es erneut.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 14px' }}>
              <button type="button" onClick={reset} style={{ ...btn, background: '#C8A44D', color: '#0E1116' }}>Try again / Erneut versuchen</button>
              <Link href="/en" style={{ ...btn, background: 'transparent', color: '#E8C776', borderColor: 'rgba(232, 199, 118, 0.7)' }}>Home</Link>
              <Link href="/de" style={{ ...btn, background: 'transparent', color: '#E8C776', borderColor: 'rgba(232, 199, 118, 0.7)' }}>Startseite</Link>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
