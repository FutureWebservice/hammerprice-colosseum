/**
 * The landing page's own sections after the owner's brief of 2026-10-04: the product text, the waiting list (markup, copy and the
 * request, with a mocked fetch), the order of the sections and the solid hero buttons. No DOM library is installed, so this renders to
 * static markup; the browser behaviour (focus, 375 px) is not covered here.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '@/locales/en/landing.json';
import de from '@/locales/de/landing.json';
import WaitlistForm from '../WaitlistForm';
import { submitWaitlist } from '../waitlist';

(globalThis as unknown as { React: typeof React }).React = React;

const ROOT = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const MSG = { en, de } as const;

describe.each(['en', 'de'] as const)('WaitlistForm (%s)', (l) => {
  const labels = MSG[l].waitlist;
  const h = renderToStaticMarkup(<WaitlistForm locale={l} labels={labels} privacyHref={`/${l}/legal/datenschutz`} />);

  it('has a visible label bound to a required email input, and a submit button', () => {
    const id = /<label class="hp-wl-label" for="([^"]+)">/.exec(h)![1];
    expect(text(h)).toContain(labels.label);
    expect(h).toMatch(new RegExp(`<input id="${id.replace(/[:]/g, '\\$&')}"[^>]*type="email"`));
    expect(h).toMatch(/type="email"[^>]*required|required=""[^>]*type="email"|<input[^>]*required=""/);
    expect(h).toMatch(/<button type="submit"[^>]*>/);
    expect(text(h)).toContain(labels.submit);
  });

  it('carries the honeypot named website, hidden from people and assistive technology', () => {
    expect(h).toMatch(/<div class="hp-wl-hp" aria-hidden="true">[\s\S]*<input type="text" tabindex="-1" autoComplete="off" name="website"/);
  });

  it('links the privacy page in the note', () => {
    expect(h).toContain(`<a href="/${l}/legal/datenschutz">${labels.privacyLink}</a>`);
  });

  it('keeps a polite live region for the success message', () => {
    expect(h).toContain('role="status" aria-live="polite"');
  });
});

describe('submitWaitlist (mocked fetch)', () => {
  const labels = MSG.en.waitlist;
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('posts {email, locale, website} as JSON to /api/waitlist and reads {ok:true} as success', async () => {
    const f = reply(200, { ok: true });
    expect(await submitWaitlist({ email: '  a@b.de ', locale: 'de', website: '' }, labels, f)).toEqual({ ok: true });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('/api/waitlist');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.de', locale: 'de', website: '' });
  });

  it('sends what a bot typed into the honeypot, so the server can drop it', async () => {
    const f = reply(200, { ok: true });
    await submitWaitlist({ email: 'a@b.de', locale: 'en', website: 'http://spam.example' }, labels, f);
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(JSON.parse(String(init.body)).website).toBe('http://spam.example');
  });

  it('maps 400, 429 and everything else to a localized message, never the server text', async () => {
    expect(await submitWaitlist({ email: 'x', locale: 'en', website: '' }, labels, reply(400, { error: 'raw server words' }))).toEqual({ ok: false, message: labels.errorInvalid });
    expect(await submitWaitlist({ email: 'x', locale: 'en', website: '' }, labels, reply(429, { error: 'rate' }))).toEqual({ ok: false, message: labels.errorTooMany });
    expect(await submitWaitlist({ email: 'x', locale: 'en', website: '' }, labels, reply(500, { error: 'boom' }))).toEqual({ ok: false, message: labels.errorGeneric });
    expect(await submitWaitlist({ email: 'x', locale: 'en', website: '' }, labels, reply(200, { nope: 1 }))).toEqual({ ok: false, message: labels.errorGeneric });
  });

  it('reports a network failure as the generic message', async () => {
    const f = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await submitWaitlist({ email: 'a@b.de', locale: 'en', website: '' }, labels, f)).toEqual({ ok: false, message: labels.errorGeneric });
  });
});

describe('the page', () => {
  const src = read('src/components/landing/HammerpriceLanding.tsx');

  it('orders hero, product text, waiting list, real cards, features, wallet help; the features exist once and nothing follows the wallet help', () => {
    const i = (s: string) => src.indexOf(s);
    const order = ['<ScrollRoom', "t('product.heading')", "t('waitlist.heading')", "t('catalogue.heading')", '<Journeys', 'id="wallet"'].map(i);
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src.match(/<Journeys/g)).toHaveLength(1);
    expect(src).not.toMatch(/FeatureGrid|FeatureStories/);
    expect(src.trimEnd().endsWith('</section>\n    </div>\n  );\n}')).toBe(true);
    expect(src).not.toContain("t('status.");
    expect(src).toContain('id="waitlist"');
    expect(src).toContain('href="#waitlist"');
  });

  it('has no component, style or key left from the old feature grid and the bottom explainers', () => {
    for (const f of ['src/components/landing/FeatureGrid.tsx', 'src/components/landing/features/FeatureStories.tsx', 'src/components/landing/features/features.css', 'src/components/landing/features/visuals.tsx']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(false);
    }
    expect(read('src/components/landing/hammerprice.css')).not.toMatch(/hp-grid/);
    for (const l of ['en', 'de'] as const) expect(MSG[l]).not.toHaveProperty('grid');
  });

  it('says plainly that the waiting list is for the mainnet launch, promises no date, and is one centred panel', () => {
    expect(MSG.en.waitlist.heading).toBe('Join the waiting list for the mainnet launch');
    expect(MSG.de.waitlist.heading).toBe('Auf die Warteliste für den Mainnet-Start');
    for (const l of ['en', 'de'] as const) {
      expect(MSG[l].waitlist.copy, l).toMatch(/Mainnet|mainnet/);
      expect(MSG[l].waitlist.copy, l).not.toMatch(/\d/);
    }
    expect(MSG.en.waitlist.copy).toContain('live in beta today');
    expect(MSG.de.waitlist.copy).toContain('live in der Beta');
    expect(src).toContain('className="hp-wl-card"');
    expect(read('src/components/landing/hammerprice.css')).toMatch(/\.hp-wl-card \{[^}]*text-align: center/);
  });

  it('has no separate waiting-list button under the stats strip (the panel sits right below); the text link and the anchor stay', () => {
    expect(src).not.toContain('landing-waitlist-cta');
    expect(src).not.toContain('hp-stats-cta');
    expect(src).toContain('id="waitlist"');
    expect(src).toContain('href="#waitlist"');
    expect(MSG.en.cta.joinWaitlist).toBe('Join the waiting list');
    expect(MSG.de.cta.joinWaitlist).toBe('Auf die Warteliste');
  });

  it('keeps the same keys in German and English', () => {
    const keys = (o: unknown, p = ''): string[] =>
      o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}.${k}`)) : [p];
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });
});

describe('contrast of the waiting-list panel (WCAG AA, 4.5:1)', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  it.each([
    ['sub line on the panel', '#c9d1cd', '#17271f'],
    ['heading on the panel', '#f4f0e6', '#17271f'],
    ['label and privacy note on the panel', '#9aa3b2', '#17271f'],
    ['placeholder on the input', '#9aa3b2', '#0e1116'],
    ['typed text on the input', '#f4f0e6', '#0e1116'],
    ['success line and privacy link on the panel', '#e8c776', '#17271f'],
    ['error on the panel', '#ff9d8c', '#17271f'],
    ['button ink on brass', '#0e1116', '#c8a44d'],
  ])('%s', (_n, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('hero buttons', () => {
  const room = read('src/components/scrolly/ScrollRoom.tsx');
  const css = read('src/components/scrolly/scrolly.css');

  it('all three use the one solid button class, with no outlined or text-link variant left', () => {
    expect(room.match(/className="scr-cta"/g)).toHaveLength(3);
    expect(room).not.toMatch(/scr-cta--alt|scr-cta-link/);
    expect(css).not.toMatch(/scr-cta--alt|scr-cta-link/);
    expect(css).toMatch(/\.scr-cta \{[^}]*background: var\(--brass\)/);
  });
});
