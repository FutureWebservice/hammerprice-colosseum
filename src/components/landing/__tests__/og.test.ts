import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

// vitest compiles JSX with the classic runtime (tsconfig says `preserve`), which needs React in scope.
(globalThis as unknown as { React: typeof React }).React = React;
const { bannerImage, iconImage, loadOgFonts, ogImage } = await import('../og');

const PNG = [0x89, 0x50, 0x4e, 0x47];
const head = async (r: Response) => [...new Uint8Array(await r.arrayBuffer()).slice(0, 4)];

describe('share images use bundled fonts, never a font CDN', () => {
  it('ships the two brand faces and their licences in assets/fonts', () => {
    for (const f of ['instrument-serif-latin-400-normal.woff', 'geist-latin-400-normal.woff', 'OFL-Geist.txt', 'OFL-Instrument-Serif.txt']) {
      expect(fs.existsSync(path.join(process.cwd(), 'assets/fonts', f)), f).toBe(true);
    }
  });

  it('loads both faces from disk', async () => {
    const fonts = await loadOgFonts();
    expect(fonts.map((f) => f.name)).toEqual(['Instrument Serif', 'Geist']);
    for (const f of fonts) expect(f.data.byteLength).toBeGreaterThan(5_000);
  });

  it('does not reference a font CDN anywhere in the image code', () => {
    for (const f of ['src/components/landing/og.tsx', 'src/app/opengraph-image.tsx']) {
      expect(fs.readFileSync(path.join(process.cwd(), f), 'utf8'), f).not.toMatch(/https?:\/\/fonts\./);
    }
  });

  it('renders a PNG share card and a PNG icon offline', async () => {
    const card = await ogImage({ kicker: 'K', headline: 'Der Hammer ist die Zahlung.', footerLeft: 'example.test' });
    expect(card.headers.get('content-type')).toBe('image/png');
    expect(await head(card)).toEqual(PNG);
    expect(await head(await iconImage(32))).toEqual(PNG);
    expect(await head(await bannerImage('dark'))).toEqual(PNG);
  }, 30_000);
});
