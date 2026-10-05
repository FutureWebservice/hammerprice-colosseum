/**
 * The shared "nothing here" panel (404, error page, empty and failed states of the packs and verify pages): markup, both languages of every text it
 * is given, the pages that use it, the colour contrast of its CSS and the house rules (no em dash, no animation).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import enCommon from '@/locales/en/common.json';
import deCommon from '@/locales/de/common.json';
import enPacks from '@/locales/en/packs.json';
import dePacks from '@/locales/de/packs.json';
import enSettlement from '@/locales/en/settlement.json';
import deSettlement from '@/locales/de/settlement.json';
import enVrf from '@/locales/en/vrf.json';
import deVrf from '@/locales/de/vrf.json';
import StatePanel, { SP_ALT, SP_PRIMARY } from '../StatePanel';
import VerifyHead from '@/components/verify/VerifyHead';

(globalThis as unknown as { React: typeof React }).React = React;
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const keys = (o: unknown, prefix = ''): string[] => (typeof o === 'object' && o !== null ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)]);

describe('StatePanel', () => {
  it('renders the rule, the kicker, the title, the body and the actions; a page has an h1, a compact one an h2', () => {
    const page = renderToStaticMarkup(<StatePanel kicker="404" title="Gone" testId="x" actions={<button type="button" className={SP_PRIMARY}>Rooms</button>}>Body text</StatePanel>);
    expect(page).toContain('sp--page');
    expect(page).toContain('<h1 class="sp-title">Gone</h1>');
    expect(page).toContain('Body text');
    expect(page).toContain('class="sp-btn"');
    const compact = renderToStaticMarkup(<StatePanel variant="compact" role="alert" kicker="k" title="T" actions={<button type="button" className={SP_ALT}>Home</button>} />);
    expect(compact).toContain('sp--compact');
    expect(compact).toContain('<h2 class="sp-title">T</h2>');
    expect(compact).toContain('role="alert"');
    expect(compact).toContain('sp-btn sp-btn--alt');
  });

  it('VerifyHead is the brass rule, a kicker, one h1 and the plain lede', () => {
    const h = renderToStaticMarkup(<VerifyHead kicker="Verification" title="Verify the bids" lede="Every bid is signed." />);
    expect(h).toContain('vf-rule');
    expect(h.match(/<h1>/g)).toHaveLength(1);
    expect(h).toContain('Every bid is signed.');
  });
});

describe('the texts exist in both languages, with the same keys', () => {
  it('common.states, packs.states, settlement.verify head keys, vrf.page head keys', () => {
    expect(keys(deCommon.states).sort()).toEqual(keys(enCommon.states).sort());
    expect(keys(dePacks.states).sort()).toEqual(keys(enPacks.states).sort());
    for (const k of ['kicker', 'missingKicker', 'rooms', 'home'] as const) {
      expect(enSettlement.verify[k], `settlement ${k}`).toBeTruthy();
      expect(deSettlement.verify[k], `settlement de ${k}`).toBeTruthy();
      expect(enVrf.page[k], `vrf ${k}`).toBeTruthy();
      expect(deVrf.page[k], `vrf de ${k}`).toBeTruthy();
    }
  });

  it('no em dash, no placeholder, German in the Sie form', () => {
    for (const o of [enCommon.states, deCommon.states, enPacks.states, dePacks.states]) {
      const s = JSON.stringify(o);
      expect(s).not.toContain('\u2014');
      expect(s).not.toMatch(/\{\{|TODO/);
    }
    expect(JSON.stringify(deCommon.states)).not.toMatch(/\b(du|dein|deine|dir|dich)\b/i);
    expect(JSON.stringify(dePacks.states)).not.toMatch(/\b(du|dein|deine|dir|dich)\b/i);
  });
});

describe('the pages that use it', () => {
  const files = [
    'src/app/[locale]/not-found.tsx', 'src/app/[locale]/error.tsx', 'src/app/[locale]/[...rest]/page.tsx', 'src/app/not-found.tsx', 'src/app/global-error.tsx',
    'src/components/ui/StatePanel.tsx', 'src/components/ui/state-panel.css', 'src/components/verify/VerifyHead.tsx', 'src/components/verify/verify.css', 'src/components/packs/PackState.tsx',
  ];
  it('the 404 and the error page offer the rooms and home, in the visitor\'s language', () => {
    const nf = read('src/app/[locale]/not-found.tsx');
    expect(nf).toContain('href="/rooms"');
    expect(nf).toContain('href="/"');
    const er = read('src/app/[locale]/error.tsx');
    expect(er).toContain('href="/rooms"');
    expect(er).toContain('onClick={reset}');
    expect(read('src/app/[locale]/[...rest]/page.tsx')).toContain('notFound()');
    for (const f of ['src/app/not-found.tsx', 'src/app/global-error.tsx']) {
      const s = read(f);
      expect(s, f).toContain('/en');
      expect(s, f).toContain('/de');
    }
  });
  it('have no em dash', () => {
    for (const f of files) expect(read(f), f).not.toContain('\u2014');
  });
  it('the packs and verify pages route their empty and failed states through the panel', () => {
    for (const f of ['src/components/packs/PacksIndex.tsx', 'src/components/packs/PackPage.tsx', 'src/components/packs/ProofView.tsx']) expect(read(f), f).toContain('PackState');
    for (const f of ['src/components/room/VerifyLot.tsx', 'src/components/vrf/VerifyRandom.tsx']) expect(read(f), f).toContain('StatePanel');
  });
});

describe('contrast of the panel CSS (WCAG AA, 4.5:1 for text) and its motion rules', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const INK = '#0e1116', BRASS = '#c8a44d', BRASS_BR = '#e8c776', PAPER = '#f4f0e6', TEXT = '#c9d1cd';
  const PANEL = '#14201f'; // the compact card: baize at 22 % over the ink, rounded up to the lighter side
  it('every text colour on its ground', () => {
    expect(ratio(PAPER, INK)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(TEXT, INK)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(TEXT, PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(BRASS, INK)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(BRASS, PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(INK, BRASS)).toBeGreaterThanOrEqual(4.5); // the primary button
    expect(ratio(INK, BRASS_BR)).toBeGreaterThanOrEqual(4.5); // its hover
    expect(ratio(BRASS_BR, INK)).toBeGreaterThanOrEqual(4.5); // the outlined button
  });
  it('the CSS uses exactly these values and no animation, transition or translucent text', () => {
    const css = read('src/components/ui/state-panel.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const v of [INK, BRASS, BRASS_BR, PAPER, TEXT]) expect(css).toContain(v);
    expect(css).not.toMatch(/animation|transition|@keyframes|\bopacity\b/);
  });
});
