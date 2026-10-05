/**
 * Guard for "yellow text on a yellow button": reads the real CSS of the packs UI, the shared kit and the sell wizard and checks that
 *  1. every rule that paints a SOLID brass background also resolves to a dark text colour with at least 4.5:1 (hover and focus rules take
 *     the colour of their base rule), and
 *  2. no link rule of a scope that hosts a button link (`.sl a`, `.pk a`, ...) colours every `a` without excluding `.hpx-btn` / `.pk-btn`
 *     (a `.sl a { color }` rule outranks the single-class `.hpx-btn` and turned the "Offer a pack" button yellow on yellow).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = ['packs/packs.css', 'packs/packs-list.css', 'ui/hpx.css', 'sell/sell.css'];
const TOKENS: Record<string, string> = { '--brass-br': '#e8c776', '--brass': '#c8a44d', '--paper': '#f4f0e6', '--ink': '#0e1116', '--slate': '#9aa3b2' };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const solid = (v: string): string | null => {
  const m = /^(?:var\((--[a-z-]+)\)|(#[0-9a-f]{6}))$/i.exec(v.trim());
  return m ? (m[1] ? TOKENS[m[1]] ?? null : m[2]!.toLowerCase()) : null;
};
const isBrass = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return r! > 150 && g! > 120 && b! < 130; };

interface Rule { selector: string; body: string; file: string }
const rules = (file: string): Rule[] => {
  const css = readFileSync(join(process.cwd(), 'src/components', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => m[1]!.split(',').map((sel) => ({ selector: sel.trim().replace(/^[\s\S]*\}\s*/, ''), body: m[2]!, file })));
};
const all = FILES.flatMap(rules);
const decl = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`).exec(body)?.[1]?.replace(/\s*!important$/, '').trim();
const baseOf = (sel: string) => sel.replace(/:(hover|focus-visible|focus|active)/g, '').replace(/:not\(:disabled\)/g, '').replace(/:disabled/g, '').trim();
const textOf = (sel: string, own: string | undefined): string | null => {
  const names = [sel, baseOf(sel), baseOf(sel).split(/\s+/).pop()];
  const v = own ?? all.filter((r) => names.includes(r.selector)).map((r) => decl(r.body, 'color')).find(Boolean);
  return v ? solid(v) : null;
};

describe('solid brass buttons carry dark ink', () => {
  const brassRules = all.filter((r) => {
    const bg = decl(r.body, 'background') ?? decl(r.body, 'background-color');
    const hex = bg ? solid(bg) : null;
    return hex !== null && isBrass(hex);
  });
  it('finds the buttons it is meant to guard (hpx primary, pk button, chips, step dots)', () => {
    const sels = brassRules.map((r) => r.selector);
    for (const s of ['.hpx-btn', '.pk-btn', '.hpx-chip--demo']) expect(sels, s).toContain(s);
  });
  it('every solid brass background resolves to a text colour with at least 4.5:1', () => {
    const bad: string[] = [];
    for (const r of brassRules) {
      if (/::?(before|after)$/.test(r.selector) && !decl(r.body, 'color')) continue; // a decorative dot or mark without text
      const bg = solid((decl(r.body, 'background') ?? decl(r.body, 'background-color'))!)!;
      const ink = textOf(r.selector, decl(r.body, 'color'));
      if (!ink || ratio(ink, bg) < 4.5) bad.push(`${r.file} ${r.selector}: text ${ink ?? 'unresolved'} on ${bg}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('the text on the booster pack stays readable', () => {
  const art = readFileSync(join(process.cwd(), 'src/components/packs/PackArt.tsx'), 'utf8');
  const plate = /<rect x="22" y="222" width="206" height="76" rx="3" fill="(#[0-9a-f]{6})"/i.exec(art)?.[1];
  it('the ribbon plate is dark and its brand line, name and sub line have at least 4.5:1 on it', () => {
    expect(plate).toBeTruthy();
    for (const sel of ['.pk-pack-word', '.pk-pack-name', '.pk-pack-sub']) {
      const r = all.find((x) => x.selector === sel && x.file === 'packs/packs.css')!;
      const ink = solid(decl(r.body, 'color') ?? '') ?? TOKENS['--paper']!;
      expect(ratio(ink, plate!), sel).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('no link rule recolours a button link', () => {
  it('every rule that sets `color` on a bare `a` descendant excludes .hpx-btn and .pk-btn', () => {
    const bad = all
      .filter((r) => /(^|[\s>+~])a(:[a-z-]+(\([^)]*\))?)*$/.test(r.selector) && decl(r.body, 'color'))
      .filter((r) => !r.selector.includes(':not(.hpx-btn)'))
      .map((r) => `${r.file} ${r.selector}`);
    // the pack notice link is plain text-sized, inside a paragraph, never a button
    expect(bad.filter((s) => !s.endsWith('.pk-notice a'))).toEqual([]);
  });
  it('the sell wizard panel button that leads to /packs/manage keeps the primary ink', () => {
    const sell = readFileSync(join(process.cwd(), 'src/components/sell/sell.css'), 'utf8');
    expect(sell).toMatch(/\.sl a:not\(\.hpx-btn\)\s*\{\s*color:/);
    const btn = all.find((r) => r.selector === '.hpx-btn' && r.file === 'ui/hpx.css')!;
    expect(ratio(solid(decl(btn.body, 'color')!)!, solid(decl(btn.body, 'background')!)!)).toBeGreaterThanOrEqual(4.5);
  });
});
