/**
 * Share images (Open Graph) and the favicon, drawn with the brand faces from files in the repository.
 *
 * ImageResponse (satori) needs real font bytes. They used to be fetched from fonts.googleapis.com at
 * request time, which sent a visitor's link preview through Google and failed silently offline. The two
 * faces are now bundled: assets/fonts/*.woff (Latin subset, SIL Open Font License, licences beside them).
 * Each path below is a literal `path.join(process.cwd(), '...')` so Next's file tracing ships the font
 * with the route that reads it.
 *
 * `ogImage()` is what the site card, the favicon and the per-room card all call, so they cannot drift.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { SITE_URL } from './site';
import { LOGO_CARD, LOGO_SYMBOL_SVG, LOGO_WORDMARK_LIGHT_SVG, LOGO_WORDMARK_SIZE, LOGO_WORDMARK_SVG } from '../brand/logo-data';

export const OG_SIZE = { width: 1200, height: 630 } as const;

const INK = '#0E1116';
const BAIZE = '#14342B';
const BRASS = '#C8A44D';
const BRASS_BRIGHT = '#E8C776';
const PAPER = '#F4F0E6';
const MUTED = '#9AA3B2';

type OgFont = { name: string; data: Buffer; style: 'normal'; weight: 400 };

/** The two brand faces as satori font entries. Throws if a bundled file is missing: that is a packaging bug, not a runtime fallback. */
export async function loadOgFonts(): Promise<OgFont[]> {
  const [serif, sans] = await Promise.all([
    readFile(path.join(process.cwd(), 'assets/fonts/instrument-serif-latin-400-normal.woff')),
    readFile(path.join(process.cwd(), 'assets/fonts/geist-latin-400-normal.woff')),
  ]);
  return [
    { name: 'Instrument Serif', data: serif, style: 'normal', weight: 400 },
    { name: 'Geist', data: sans, style: 'normal', weight: 400 },
  ];
}

export interface OgCard {
  /** Small brass line above the headline ("LIVE AUCTIONS"). */
  kicker: string;
  headline: string;
  /** One line under the headline. */
  deck?: string;
  /** A second, smaller headline line (the other language on the site card). */
  headline2?: string;
  /** Labelled chip next to the wordmark, for example "DEVNET". */
  badge?: string;
  /** Bottom rule, left and right. */
  footerLeft: string;
  footerRight?: string;
}

/** An SVG document as an image source satori can draw (the logo shapes live in brand/logo-data.ts). */
export const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const serifStack = 'Instrument Serif';
const sansStack = 'Geist';

function card(c: OgCard) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: INK,
        padding: '72px 88px',
        position: 'relative',
      }}
    >
      {/* A flat baize wash (no gradient text, no glass): the table the card sits on. */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1200, height: 630, background: BAIZE, opacity: 0.4, display: 'flex' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- satori draws this as an image; there is no DOM to read */}
        <img src={svgUri(LOGO_WORDMARK_SVG)} width={Math.round((LOGO_WORDMARK_SIZE.w * 48) / LOGO_WORDMARK_SIZE.h)} height={48} />
        {c.badge ? (
          <span
            style={{
              fontFamily: sansStack,
              fontSize: 18,
              letterSpacing: '0.14em',
              color: BRASS_BRIGHT,
              border: `1px solid ${BRASS}`,
              padding: '6px 14px',
              display: 'flex',
            }}
          >
            {c.badge}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1000 }}>
        <span style={{ fontFamily: sansStack, fontSize: 20, letterSpacing: '0.16em', color: BRASS, display: 'flex' }}>{c.kicker}</span>
        <div style={{ fontFamily: serifStack, fontSize: 76, lineHeight: 1.06, color: PAPER, display: 'flex' }}>{c.headline}</div>
        {c.headline2 ? (
          <div style={{ fontFamily: serifStack, fontSize: 44, lineHeight: 1.1, color: BRASS_BRIGHT, display: 'flex' }}>{c.headline2}</div>
        ) : null}
        {c.deck ? <div style={{ fontFamily: sansStack, fontSize: 28, lineHeight: 1.4, color: MUTED, display: 'flex' }}>{c.deck}</div> : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${BRASS}55`, paddingTop: 26 }}>
        <span style={{ fontFamily: sansStack, fontSize: 18, letterSpacing: '0.08em', color: BRASS_BRIGHT }}>{c.footerLeft}</span>
        <span style={{ fontFamily: sansStack, fontSize: 18, letterSpacing: '0.08em', color: MUTED }}>{c.footerRight ?? ''}</span>
      </div>
    </div>
  );
}

/** A 1200x630 PNG share image. */
export async function ogImage(c: OgCard): Promise<ImageResponse> {
  return new ImageResponse(card(c), { ...OG_SIZE, fonts: await loadOgFonts() });
}

/** The host shown in the card footer: the real serving host, never a domain the project does not own. */
export const SITE_HOST = new URL(SITE_URL).host;

/**
 * The favicon, the web-app icon and the square avatar: the logo symbol (a card with a gavel) on the ink ground, `px` pixels square.
 * `scale` is the card's height as a share of the side: 0.78 for the normal icons (a tab shows it at 16 px), 0.62 for the avatar,
 * 0.5 for the maskable one (the OS crops that to a circle).
 */
export async function iconImage(px: number, scale = 0.78): Promise<ImageResponse> {
  const h = Math.round(px * scale);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: INK }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- satori draws this as an image */}
        <img src={svgUri(LOGO_SYMBOL_SVG)} width={Math.round((h * LOGO_CARD.w) / LOGO_CARD.h)} height={h} />
      </div>
    ),
    { width: px, height: px },
  );
}

/** The 1600 x 400 banner PNG, the wordmark 76 percent of the width, centred: `transparent` (for dark grounds), `dark` (on ink) or `light` (ink letters, transparent). */
export async function bannerImage(kind: 'transparent' | 'dark' | 'light'): Promise<ImageResponse> {
  const w = 1216;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: kind === 'dark' ? INK : 'transparent' }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- satori draws this as an image */}
        <img src={svgUri(kind === 'light' ? LOGO_WORDMARK_LIGHT_SVG : LOGO_WORDMARK_SVG)} width={w} height={Math.round((w * LOGO_WORDMARK_SIZE.h) / LOGO_WORDMARK_SIZE.w)} />
      </div>
    ),
    { width: 1600, height: 400 },
  );
}
