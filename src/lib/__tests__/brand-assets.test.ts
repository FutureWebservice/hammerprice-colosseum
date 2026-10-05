/**
 * The brand files and the metadata text. A favicon that is missing
 * (the browser then shows a stale one) or a title that still carries the old name is a defect nobody sees in a code review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

const pngSize = (f: string) => {
  const b = fs.readFileSync(path.join(ROOT, f));
  expect(b.subarray(1, 4).toString(), f).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('icons', () => {
  it('has a favicon.ico with 16, 32 and 48 pixel frames', () => {
    const b = fs.readFileSync(path.join(ROOT, 'public/favicon.ico'));
    expect(b.readUInt16LE(2), 'ICO type').toBe(1);
    const n = b.readUInt16LE(4);
    expect(Array.from({ length: n }, (_, i) => b[6 + 16 * i]).sort((a, c) => a - c)).toEqual([16, 32, 48]);
  });

  it('has the PNG sizes the manifest and the head promise', () => {
    expect(pngSize('public/apple-touch-icon.png')).toEqual([180, 180]);
    expect(pngSize('public/icons/icon-192.png')).toEqual([192, 192]);
    expect(pngSize('public/icons/icon-512.png')).toEqual([512, 512]);
    expect(pngSize('public/icons/icon-512-maskable.png')).toEqual([512, 512]);
    expect(read('public/icons/icon.svg')).toContain('<svg');
  });

  it('lists in the manifest only icons that exist, with a maskable one among them', () => {
    const m = JSON.parse(read('public/manifest.webmanifest')) as { icons: { src: string; purpose: string }[] };
    for (const i of m.icons) expect(fs.existsSync(path.join(ROOT, 'public', i.src)), i.src).toBe(true);
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('wires every icon, the manifest and the theme colour into the root layout, and keeps no second icon route', () => {
    const layout = read('src/app/[locale]/layout.tsx');
    for (const s of ['/favicon.ico', '/icons/icon.svg', '/icons/icon-192.png', '/apple-touch-icon.png', "manifest: '/manifest.webmanifest'", "themeColor: '#0E1116'"]) expect(layout, s).toContain(s);
    expect(fs.existsSync(path.join(ROOT, 'src/app/icon.tsx'))).toBe(false); // it would add a second <link rel="icon"> next to the files
    expect(fs.existsSync(path.join(ROOT, 'public/logo.png'))).toBe(false); // an old mascot
  });
});

describe('logo files', () => {
  const SVGS = ['logo-symbol', 'logo-symbol-white', 'logo-symbol-black', 'logo-wordmark', 'logo-wordmark-light', 'logo-wordmark-white', 'logo-wordmark-black', 'logo-wordmark-tagline', 'logo-wordmark-tagline-light', 'logo-square-512'];

  it('ships every SVG with an accessible name, outlined letters and nothing external', () => {
    for (const n of SVGS) {
      const s = read(`public/brand/${n}.svg`);
      expect(s, n).toMatch(/^<svg [^>]*viewBox="[^"]+" role="img" aria-label="Hammerprice/);
      expect(s, n).not.toMatch(/<text|font-family|<image|<script|href=|@import|url\((?!#)/); // no live text, no font, no raster, no outside reference
      expect(s, n).not.toContain('\u2014');
    }
  });

  it('ships the PNG set at the sizes the forms ask for', () => {
    expect(pngSize('public/brand/logo-square-512.png')).toEqual([512, 512]);
    expect(pngSize('public/brand/telegram-bot-avatar.png')).toEqual([512, 512]); // BotFather /setuserpic
    for (const n of ['logo-wordmark-1600x400', 'logo-wordmark-dark-1600x400', 'logo-wordmark-light-1600x400']) expect(pngSize(`public/brand/${n}.png`), n).toEqual([1600, 400]);
  });

  it('keeps the symbol readable: brass on ink, and the ink and the paper letters on their grounds, clear the 4.5:1 text contrast', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    expect(ratio('#E8C776', '#0E1116')).toBeGreaterThan(4.5);
    expect(ratio('#F4F0E6', '#0E1116')).toBeGreaterThan(4.5);
    expect(ratio('#0E1116', '#F4F0E6')).toBeGreaterThan(4.5);
    expect(read('public/brand/logo-wordmark.svg')).toContain('fill="#E8C776"');
  });

  it('is what the site shows: the header and footer use the wordmark file, the icon is the symbol on ink', () => {
    expect(read('src/components/brand/Logo.tsx')).toContain('/brand/logo-wordmark.svg');
    for (const f of ['src/components/layout/Header.tsx', 'src/components/layout/Footer.tsx']) expect(read(f), f).toContain("components/brand/Logo'");
    expect(read('public/icons/icon.svg')).toContain('fill="#0E1116"');
  });

  it('shows no old text logo: the About hero, the landing close, the footer, the admin bar and the AI avatar use the logo files', () => {
    expect(read('src/components/pitch/PitchSections.tsx')).toMatch(/<Logo className="pt-bill-logo" alt="Hammerprice"/);
    expect(read('src/components/landing/HammerpriceLanding.tsx')).toMatch(/<Logo className="hp-wl-logo"/);
    expect(read('src/components/layout/Footer.tsx')).toContain('variant="tagline"');
    expect(read('src/app/[locale]/admin/layout.tsx')).toContain('<Logo');
    expect(read('src/components/ai/AgentChat.tsx')).toContain('<Logo variant="symbol"');
    for (const f of walk('src').filter((x) => /\.tsx$/.test(x) && !x.includes('__tests__'))) {
      expect(read(f), f).not.toMatch(/>\s*HAMMERPRICE\s*</); // the name is a picture, not a line of capitals
    }
  });
});

describe('sitemap and robots', () => {
  it('lists About and the AI page in both languages, /packs only while its feature is on, and never the admin, seller or API paths', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    const { default: robots } = await import('@/app/robots');
    const urls = () => sitemap().map((e) => new URL(e.url).pathname);
    delete process.env.FEATURE_PACKS;
    for (const p of ['/en/about', '/de/about', '/en/ai', '/de/ai', '/en/rooms']) expect(urls()).toContain(p);
    expect(urls()).not.toContain('/en/packs');
    process.env.FEATURE_PACKS = 'true';
    expect(urls()).toEqual(expect.arrayContaining(['/en/packs', '/de/packs']));
    delete process.env.FEATURE_PACKS;
    for (const u of urls()) expect(u).not.toMatch(/\/(admin|sell|account|verify|api)(\/|$)/);
    const r = robots();
    const allow = ([] as string[]).concat((r.rules as { allow: string | string[] }).allow);
    expect(allow).toEqual(expect.arrayContaining(['/en/about$', '/en/ai$', '/en/packs']));
    expect(allow.some((a) => /admin|^\/api/.test(a))).toBe(false);
    expect(r.sitemap).toContain('/sitemap.xml');
  });
});

describe('no trace of the old brand in public files and metadata', () => {
  const OLD = /bonkstream/i;

  it('public/ has no text file that names it', () => {
    for (const f of walk('public').filter((x) => /\.(txt|json|webmanifest|svg|xml|html)$/.test(x))) expect(read(f), f).not.toMatch(OLD);
  });

  it('no title or description in a locale file, a legal front matter or a route metadata block names it', () => {
    const bad: string[] = [];
    const scan = (v: unknown, trail: string, inMeta: boolean) => {
      if (typeof v === 'string') {
        if (inMeta && /(title|description|meta)$/i.test(trail) && OLD.test(v)) bad.push(trail);
      } else if (v && typeof v === 'object') {
        for (const [k, c] of Object.entries(v)) scan(c, `${trail}.${k}`, inMeta || k === 'meta');
      }
    };
    for (const f of walk('src/locales').filter((x) => x.endsWith('.json'))) scan(JSON.parse(read(f)), f, false);
    for (const f of walk('src/legal/content').filter((x) => x.endsWith('.md'))) {
      const front = /^---\n([\s\S]*?)\n---/.exec(read(f))?.[1] ?? '';
      if (OLD.test(front)) bad.push(f);
    }
    for (const f of ['src/app/[locale]/layout.tsx', 'src/app/[locale]/page.tsx', 'src/app/opengraph-image.tsx', 'src/app/not-found.tsx']) if (OLD.test(read(f))) bad.push(f);
    expect(bad).toEqual([]);
  });
});
