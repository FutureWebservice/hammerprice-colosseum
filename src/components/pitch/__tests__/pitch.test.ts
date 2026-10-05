/**
 * The pitch-formatted parts of /about (claims 160 to 164, reworked in claims 190 to 199): the image strip of device-framed screenshots (every
 * picture exists in both languages as a WebP and as the README's jpg, is an optimised jpg of about the stated width and under 250 KB, and has an alt text), the copy describes the
 * product as it runs (live in beta, no network, status or caveat wording, no user, volume or revenue figure) and every text colour of pitch.css
 * meets 4.5:1 on its background.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import de from '@/locales/de/pitch.json';
import en from '@/locales/en/pitch.json';
import deExplain from '@/locales/de/explain.json';
import enExplain from '@/locales/en/explain.json';

const ROOT = process.cwd();
const LOCALES = { en, de } as const;
const css = fs.readFileSync(path.join(ROOT, 'src/components/pitch/pitch.css'), 'utf8');

/** Width and height of a baseline or progressive jpg, read from its SOF marker (no image library needed). */
function jpgSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  expect(b[0] === 0xff && b[1] === 0xd8, `${file} is a jpg`).toBe(true);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error(`no SOF marker in ${file}`);
}

const IDS = ['landing', 'journeys', 'rooms', 'room', 'pay', 'chat', 'agent', 'profile', 'wallet', 'mobile'];

describe('the showcase', () => {
  it('has the same ten pictures in both languages, in the same order, with the phone frame on the mobile one only', () => {
    for (const l of ['en', 'de'] as const) {
      const items = LOCALES[l].showcase.items;
      expect(items.map((s) => s.id), l).toEqual(IDS);
      expect(items.filter((s) => s.frame === 'phone').map((s) => s.id), l).toEqual(['mobile']);
    }
  });

  it.each(['en', 'de'] as const)('%s: every picture exists, is a jpg of about the stated width and under 250 KB, and has an alt text and one short line', (l) => {
    for (const s of LOCALES[l].showcase.items) {
      // The page serves WebP (about half the bytes); the JPEG of the same picture stays for the README.
      expect(s.src, s.id).toBe(`/pitch/${l}/${s.id}.webp`);
      const webp = path.join(ROOT, 'public', s.src);
      const file = webp.replace(/\.webp$/, '.jpg');
      expect(fs.existsSync(webp), webp).toBe(true);
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.statSync(file).size, `${s.src} (jpg) is under 250 KB`).toBeLessThanOrEqual(250 * 1024);
      expect(fs.statSync(webp).size, `${s.src} is lighter than its jpg`).toBeLessThan(fs.statSync(file).size * 0.7);
      const { w, h } = jpgSize(file);
      expect([w, h], `${s.src} has the size the page declares`).toEqual([s.width, s.height]);
      expect(w, `${s.src} is 1600 px wide (the phone picture 780)`).toBe(s.frame === 'phone' ? 780 : 1600);
      expect(s.alt.length, `${s.id} alt`).toBeGreaterThan(25);
      expect(s.body.split(/\s+/).length, `${s.id} is one short line`).toBeLessThanOrEqual(10);
      expect(s.alt, `${s.id} alt differs from the line`).not.toBe(s.body);
    }
  });
});

describe('the pitch copy', () => {
  const NETWORK = /devnet|testnet|test network|testnetz|test[- ]usdc|spielgeld|replica|replikat/i;
  it.each(['en', 'de'] as const)('%s: describes the current product, with no network wording and no old status wording', (l) => {
    const text = JSON.stringify(LOCALES[l]);
    expect(text).not.toMatch(NETWORK);
    expect(text).not.toMatch(/real in this build|in diesem Build echt/i);
    expect(text).not.toMatch(/\b(users?|nutzer(innen)?|umsatz|revenue|volume|volumen)\b[^"]{0,30}\d|\d[^"]{0,30}\b(users?|nutzer(innen)?|umsatz|revenue)\b/i);
    expect(text).not.toContain('\u2014');
  });

  it('says live and in beta and points to the waiting list, with no status table and no statement of what is not done', () => {
    // The one line about the beta and the waiting list stands in the closing section, not in the hero.
    expect(enExplain.closing.body).toMatch(/is live and currently in beta/);
    expect(enExplain.closing.body).toMatch(/waiting list/);
    expect(deExplain.closing.body).toMatch(/ist live und befindet sich derzeit in der Beta/);
    expect(deExplain.closing.body).toMatch(/Warteliste/);
    for (const l of ['en', 'de'] as const) {
      expect(JSON.stringify(LOCALES[l]), l).not.toMatch(/status table|statustabelle|solo founder|alleingründer|deliberately cut|bewusst gestrichen|not something done|nichts Erledigtes|not (yet )?(tested|verified)|nicht (live )?getestet/i);
    }
  });

  it('names every current function: rooms, one-transaction settlement, timed auctions, wizard with AI draft, pre-moderated chat, AI agent that never bids, Telegram and /watch, packs, profile and wallet, ECVRF, audit pages, two languages, wallets', () => {
    const feats = (l: 'en' | 'de') => LOCALES[l].features.items.map((f) => `${f.title} ${f.body}`).join(' ');
    for (const re of [/Rooms/, /transaction/, /Timed/i, /wizard/i, /drafts a title/i, /moderated/i, /never bids/i, /Telegram/, /\/watch/, /pre-filled/i, /Packs/, /odds/i, /Profile/i, /ECVRF/, /audit/i, /German and English/, /Wallet support/]) expect(feats('en')).toMatch(re);
    for (const re of [/Räume/, /Transaktion/, /Zeitlich/i, /Verkaufsassistent/, /KI/, /Vormoderiert/, /nie bietet/i, /Telegram/, /\/watch/, /vorausgefüllt/i, /Packs/, /Wahrscheinlichkeiten/, /Profil/, /ECVRF/, /Prüfseiten/, /Deutsch und Englisch/, /Wallet-Unterstützung/]) expect(feats('de')).toMatch(re);
  });

  it('describes the six steps of How it works for the three roles', () => {
    for (const l of ['en', 'de'] as const) {
      const how = LOCALES[l].how;
      expect(how.steps, l).toHaveLength(6);
      expect([...new Set(how.steps.flatMap((s) => s.roles))].sort(), l).toEqual(['all', 'buyer', 'host', 'seller']);
      for (const r of ['all', 'buyer', 'seller', 'host'] as const) expect(how.roles[r].length).toBeGreaterThan(3);
    }
  });

  it('speaks to the reader in the Sie form in German', () => {
    const de_ = JSON.stringify(de);
    expect(de_).not.toMatch(/\b(du|dein|deine|deinen|deiner|dir)\b/i);
    expect(de_).toMatch(/\bSie\b|\bIhre\b/);
  });
});

describe('pitch.css text colours meet 4.5:1', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const tok = Object.fromEntries([...css.matchAll(/(--pt-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));

  it('every token pair a text sits on', () => {
    const pairs: Array<[string, string]> = [
      ['--pt-paper', '--pt-ink'], ['--pt-paper-dim', '--pt-ink'], ['--pt-slate', '--pt-ink'], ['--pt-brass', '--pt-ink'], ['--pt-brass-br', '--pt-ink'],
      ['--pt-paper', '--pt-ink-2'], ['--pt-paper-dim', '--pt-ink-2'], ['--pt-slate', '--pt-ink-2'], ['--pt-brass', '--pt-ink-2'],
      ['--pt-paper', '--pt-baize'],
      ['--pt-paper', '--pt-glass'], ['--pt-paper-dim', '--pt-glass'], ['--pt-slate', '--pt-glass'], ['--pt-brass', '--pt-glass'], ['--pt-brass-br', '--pt-glass'],
    ];
    for (const [fg, bg] of pairs) {
      expect(tok[fg], fg).toBeTruthy();
      expect(ratio(tok[fg]!, tok[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the brass button text and the footer-line colours', () => {
    expect(ratio('#221a08', tok['--pt-brass']!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#221a08', tok['--pt-brass-br']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the showcase has no animation, no transition and no opacity below 1', () => {
    const show = css.slice(css.indexOf('/* --- the showcase'), css.indexOf('/* --- the ledger')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(show.length).toBeGreaterThan(500);
    expect(show).not.toMatch(/animation|transition|opacity/);
  });
});
