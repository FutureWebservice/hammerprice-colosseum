/**
 * The journey blocks of the landing page ("What you can do on Hammerprice"), server render, both languages, switches on and off.
 * No DOM library is installed, so layout at 375 px is not checked here; here is the markup,
 * the links, the words, their truth against the product's own strings, and the contrast of every colour the CSS uses.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { allOnEnv } from '@/content/features';
import en from '@/locales/en/landing.json';
import de from '@/locales/de/landing.json';
import enTg from '@/locales/en/telegram.json';
import deTg from '@/locales/de/telegram.json';
import Journeys, { JOURNEYS, MORE } from '../Journeys';

(globalThis as unknown as { React: typeof React }).React = React;

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const MSG = { en: en.journeys, de: de.journeys } as const;
const DETAILS = 3; // the slim lines of the packs block (h4): odds, build, delivery
const TG = { en: enTg, de: deTg } as const;

describe.each(['en', 'de'] as const)('Journeys (%s)', (l) => {
  const h = renderToStaticMarkup(<Journeys locale={l} env={allOnEnv('devnet')} />);
  const m = MSG[l];

  it('is one h2, then one h3 per journey plus "And more", then one h4 per compact item; no h1, no skipped level', () => {
    expect(h).not.toContain('<h1');
    expect(h.match(/<h2/g)).toHaveLength(1);
    expect(h.match(/<h3/g)).toHaveLength(JOURNEYS.length + 1);
    expect(h.match(/<h4/g)).toHaveLength(MORE.length + DETAILS);
    expect(h.indexOf('<h2')).toBeLessThan(h.indexOf('<h3'));
    expect(h.indexOf('<h4')).toBeGreaterThan(h.indexOf('<h3')); // the packs cards sit under their own h3
    expect(h.indexOf('<h4', h.lastIndexOf('<h3'))).toBeGreaterThan(-1); // and the compact items under "And more"
  });

  it('lists the seven journeys in the order of the owner brief, each with 2 to 5 steps and a decorative picture', () => {
    expect(JOURNEYS.map((j) => j.id)).toEqual(['bid', 'sell', 'packs', 'chat', 'telegram', 'agent', 'profile']);
    for (const { id } of JOURNEYS) {
      const item = m.items[id];
      expect(text(h), id).toContain(item.title);
      expect(item.steps.length, id).toBeGreaterThanOrEqual(2);
      expect(item.steps.length, id).toBeLessThanOrEqual(5);
      for (const s of item.steps) expect(text(h), id).toContain(s);
      expect(h, id).toContain(`id="journey-${id}-h"`);
    }
    expect(h.match(/class="hp-jb-vis" aria-hidden="true"/g)).toHaveLength(JOURNEYS.length);
    expect(h.match(/class="hp-jb(?: hp-jb--flip)?"/g)).toHaveLength(JOURNEYS.length);
    expect(h.match(/hp-jb--flip/g)).toHaveLength(3); // alternating (the 2nd, 4th and 6th block)
  });

  it('points every aria-labelledby at an id that exists, with no id twice', () => {
    const ids = [...h.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of [...h.matchAll(/aria-labelledby="([^"]+)"/g)].map((x) => x[1])) expect(ids).toContain(ref);
  });

  it('has a button that is a link to the real page for every journey, in the hero button style', () => {
    const hrefs = [...h.matchAll(/<a class="hp-j-cta(?: hp-j-cta--alt)?" href="([^"]+)"/g)].map((x) => x[1]);
    expect(hrefs).toEqual([
      `/${l}/rooms`, `/${l}/sell`, `/${l}/packs`, `/${l}/rooms`, `/${l}/account?telegram=open`, 'https://t.me/hammerpricebot', `/${l}/ai`, `/${l}/account`,
    ].map((x) => x.replace(/&/g, '&amp;')));
    for (const { id } of JOURNEYS) expect(text(h), id).toContain(m.items[id].cta);
    expect(m.items.telegram.cta2).toBeTruthy();
    expect(h).toMatch(/href="https:\/\/t\.me\/hammerpricebot" target="_blank" rel="noopener noreferrer"/);
    expect(h).not.toMatch(/<button/);
  });

  it('names what the owner asked for: wallet, bidder number, one signature, 2.5 percent, /watch, approval, popup, no custody', () => {
    const all = text(h);
    for (const w of ['@hammerpricebot', '/watch 3', '/watch all', 'USDC', 'SOL']) expect(all, w).toContain(w);
    expect(all).toMatch(l === 'en' ? /2\.5 percent/ : /2,5 Prozent/);
    expect(all).toMatch(l === 'en' ? /never bids for you/ : /bietet nie für Sie/);
    expect(all).toMatch(l === 'en' ? /bidder number/ : /Bieternummer/);
  });

  it('"And more" holds the eight other features, each with a title, one or two sentences and a link', () => {
    expect(MORE.map((x) => x.id)).toEqual(['timed', 'random', 'packs', 'video', 'draft', 'verify', 'languages', 'wallets']);
    for (const { id } of MORE) {
      const item = m.more[id];
      expect(text(h), id).toContain(item.title);
      expect(text(h), id).toContain(item.line);
      expect(text(h), id).toContain(item.link);
      expect(item.line.split(/(?<=[.!?])\s+/).length, id).toBeLessThanOrEqual(2);
      expect(h, id).toMatch(new RegExp(`data-more="${id}"`));
    }
    const hrefs = [...h.matchAll(/<a class="hp-jmore-link"[^>]*href="([^"]+)"/g)].map((x) => x[1]);
    const other = l === 'en' ? 'de' : 'en';
    expect(hrefs).toEqual([`/${l}/rooms`, `/${l}/room/house`, '#journey-packs', `/${l}/rooms`, `/${l}/ai`, `/${l}/about#verify`, `/${other}`, '#wallet']);
    expect(h).toContain(`hrefLang="${other}"`);
  });

  it('keeps "And more" out of the double presentation: no title appears twice on the page section', () => {
    const titles = [...JOURNEYS.map((j) => m.items[j.id].title), ...MORE.map((x) => m.more[x.id].title)];
    expect(new Set(titles).size).toBe(titles.length);
    const ids = [...h.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws no link to a page that a switched-off feature answers with 404, and no Telegram or AI button then', () => {
    const off = renderToStaticMarkup(<Journeys locale={l} env={{ SOLANA_CLUSTER: 'devnet' }} />);
    expect(off).not.toContain(`/${l}/ai"`);
    expect(off).not.toContain(`/${l}/packs"`);
    expect(off).not.toContain('t.me/hammerpricebot');
    expect(off).not.toContain('telegram=open');
    // the packs block goes with its page; its short card in "And more" stays as a description without a link
    expect(off.match(/<h3/g)).toHaveLength(JOURNEYS.length);
    expect(off.match(/<h4/g)).toHaveLength(MORE.length);
    expect(off).not.toContain('journey-packs');
    expect(text(off)).toContain(m.more.packs.title);
    expect(off).not.toContain(`/${l}/room/house"`);
    expect(off).toContain('href="#wallet"');
    expect(off).toContain(`/${l}/sell"`);
    expect(off).toContain(`/${l}/account"`);
  });

  it('says nothing about devnet or a test network, claims no user, volume or revenue figure, and uses no em dash', () => {
    expect(text(h)).not.toMatch(/devnet|testnet|test network|testnetz|test[- ]usdc|spielgeld/i);
    expect(text(h)).not.toMatch(/\b\d+ (users|nutzer)|revenue|umsatz|volume|volumen/i);
    expect(JSON.stringify(m)).not.toContain('\u2014');
    expect(h).not.toContain('\u2014');
  });

  it('shows the Telegram bubble with the real button words of the bot (src/locales/*/telegram.json)', () => {
    const { bidButton, bidButtonPlus } = TG[l].bot;
    const re = (tpl: string) => new RegExp(`^${tpl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{amount\\}', '[\\d.,]+')}$`);
    expect(m.items.telegram.mock.bid).toMatch(re(bidButton));
    expect(m.items.telegram.mock.bidPlus).toMatch(re(bidButtonPlus));
  });
});

describe.each(['en', 'de'] as const)('the packs block (%s)', (l) => {
  const h = renderToStaticMarkup(<Journeys locale={l} env={allOnEnv('devnet')} />);
  const m = MSG[l].items.packs;
  const block = h.slice(h.indexOf('id="journey-packs"'), h.indexOf('id="journey-chat"'));

  it('has 4 to 5 steps, the yellow button to /packs, an aria-hidden picture, the flow and a slim row of three lines', () => {
    expect(m.steps.length).toBeGreaterThanOrEqual(4);
    expect(m.steps.length).toBeLessThanOrEqual(5);
    expect(block).toContain(`<a class="hp-j-cta" href="/${l}/packs">${m.cta}</a>`);
    expect(block).toContain('class="hp-jb-vis" aria-hidden="true"');
    expect(block).toContain('class="hp-jx hp-jflow" aria-hidden="true"');
    expect(block.match(/<h4 class="hp-jd-t"/g)).toHaveLength(DETAILS);
    expect(Object.keys(m.details)).toEqual(['odds', 'build', 'delivery']);
    expect(text(block)).toContain(m.flow.platform);
  });

  it('draws the sealed pack, the odds bar of 70, 25 and 5 and a pool grid of 12 cards', () => {
    expect(block).toContain('hp-pk-seal');
    expect(block).toMatch(/flex-grow:70[^>]*><\/span><span class="hp-pk-r" style="flex-grow:25[^>]*><\/span><span class="hp-pk-x" style="flex-grow:5/);
    expect(block.match(/<span class="hp-pk-[crx]"><\/span>/g)).toHaveLength(12);
    expect(m.mock.t1 + m.mock.t2 + m.mock.t3).toMatch(/70.*25.*5/);
  });

  it('keeps the landing slim: three lines of at most 14 words, no paragraph and no list, each with a "Details" link to the explainer anchor', () => {
    const row = block.slice(block.indexOf('class="hp-jx hp-jd"'));
    for (const id of ['odds', 'build', 'delivery'] as const) {
      const d = m.details[id];
      expect(d.line.split(/\s+/).length, id).toBeLessThanOrEqual(14);
      expect(row, id).toContain(`<a class="hp-jd-link" href="/${l}/packs#${id}">${m.detailsLink}</a>`);
      expect(text(row), id).toContain(d.title);
      expect(text(row), id).toContain(d.line);
    }
    expect(m.detailsLink).toBe('Details');
    expect(row.match(/<p>/g)).toHaveLength(3);
    expect(row).not.toMatch(/<ul[^>]*>\s*<li[^>]*>\s*<(?:ul|ol)/);
    expect(text(row)).not.toMatch(/10[.,]000|basis point|Basispunkt|ECVRF|strike|Verwarnung/);
  });

  it('keeps the peer-to-peer picture: the platform never receives the price and holds no card', () => {
    expect(text(block)).toMatch(l === 'en' ? /never receives the price/ : /erhält nie den Preis/);
  });
});

describe('words and structure', () => {
  const keys = (o: unknown, p = ''): string[] =>
    o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}.${k}`)) : [p];

  it('has the same keys and the same number of steps in German and English', () => {
    expect(keys(de.journeys).sort()).toEqual(keys(en.journeys).sort());
    for (const { id } of JOURNEYS) expect(de.journeys.items[id].steps).toHaveLength(en.journeys.items[id].steps.length);
  });

  it('the page puts the journeys after the real cards and before the wallet help', () => {
    const src = read('src/components/landing/HammerpriceLanding.tsx');
    expect(src.indexOf('<Journeys')).toBeGreaterThan(src.indexOf("t('catalogue.heading')"));
    expect(src.indexOf('<Journeys')).toBeLessThan(src.indexOf('id="wallet"'));
  });

  it('the CSS moves nothing: no animation, no transition, no opacity below 1', () => {
    const css = read('src/components/landing/journeys/journeys.css');
    expect(css).not.toMatch(/@keyframes|animation\s*:|transition\s*:|opacity\s*:/);
  });
});

describe('contrast of every colour pair the journey CSS uses (WCAG AA, 4.5:1 for text)', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const css = read('src/components/landing/journeys/journeys.css');
  const PAIRS: Array<[string, string, string]> = [
    ['steps and lead on the page', '#c9d1cd', '#0e1116'],
    ['brass-br on the page', '#e8c776', '#0e1116'],
    ['button ink on brass', '#0e1116', '#c8a44d'],
    ['button ink on brass-br (hover)', '#0e1116', '#e8c776'],
    ['outlined button on the page', '#e8c776', '#0e1116'],
    ['example label on its panel', '#9aa3b2', '#0f1f1a'],
    ['mock text on the mock', '#f4f0e6', '#101814'],
    ['mock muted on the mock', '#9aa3b2', '#101814'],
    ['mock brass on the mock', '#e8c776', '#101814'],
    ['mock steps on the mock', '#c9d1cd', '#101814'],
    ['chip on baize', '#f4f0e6', '#1d4a3c'],
    ['chip on brass', '#0e1116', '#c8a44d'],
    ['italic note on the bubble', '#d6ddd9', '#1d4a3c'],
    ['italic note on the bot bubble', '#d6ddd9', '#182430'],
    ['bubble text', '#f4f0e6', '#2a3a35'],
    ['toast text', '#f4f0e6', '#17211c'],
    ['telegram button', '#f4f0e6', '#243648'],
    ['step number on baize', '#f4f0e6', '#1d4a3c'],
    ['compact title link on the card', '#e8c776', '#0e1116'],
  ];
  it.each(PAIRS)('%s', (_n, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it('uses only colours that the pairs above cover', () => {
    const used = new Set([...css.matchAll(/#[0-9a-f]{6}\b/gi)].map((x) => x[0].toLowerCase()));
    const covered = new Set(PAIRS.flatMap(([, a, b]) => [a, b]));
    // decorative borders and fills with no text on them
    const decorative = new Set(['#1c2620', '#c8a44d']);
    for (const c of used) expect(covered.has(c) || decorative.has(c), c).toBe(true);
  });
});
