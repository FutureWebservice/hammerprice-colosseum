import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve(__dirname, '../packs.css'), 'utf8');

describe('packs.css', () => {
  it('lifts the sticky buy column above the pool cards while a sheet (wallet, pay) is open, because the column is its own stacking context', () => {
    expect(css).toMatch(/\.pk-side \{ position: sticky;/);
    expect(css).toMatch(/body:has\(\.hp-sheet\) \.pk-side \{ z-index: 80; \}/);
  });
  it('switches every animation and transition off under prefers-reduced-motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/animation:\s*none\s*!important/);
    expect(block).toMatch(/transition:\s*none\s*!important/);
  });
  it('animates only compositor properties in the opening (transform, opacity, filter), never layout', () => {
    const blocks: { name: string; body: string }[] = [];
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      let depth = 1, i = m.index! + m[0].length;
      const start = i;
      while (depth > 0 && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
      blocks.push({ name: m[1]!, body: css.slice(start, i - 1) });
    }
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    for (const { name, body } of blocks) expect(body, name).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
  });
  it('the opening is ONE full-bleed layer: 100vw break-out that beats the page\'s max-width, 80svh, no border, no radius, no card background, no frame on the card back', () => {
    const rule = (sel: string) => new RegExp(`^${sel.replace(/[.[\]']/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
    const stage = rule('.pk-reveal');
    expect(stage).toMatch(/width: 100vw/);
    expect(stage).toMatch(/max-width: none/);
    expect(stage).toMatch(/margin-left: calc\(50% - 50vw\)/);
    expect(stage).toMatch(/min-height: 80svh/);
    expect(stage).toMatch(/border: 0/);
    expect(stage).toMatch(/border-radius: 0/);
    expect(stage).not.toMatch(/(?<![-\w])(box-shadow: (?!none))/);
    expect(stage).toMatch(/var\(--ink\)/); // the ground is the page's own ink: no visible outline
    expect(rule('.pk-stage')).not.toMatch(/border|background|box-shadow/);
    expect(css).not.toMatch(/\.pk-face--back::after/);
    expect(rule('.pk-face--back')).not.toMatch(/border/);
  });
  it('has no gradient text (the house style): no background-clip: text', () => {
    expect(css).not.toMatch(/background-clip:\s*text|-webkit-text-fill-color/);
  });
  it('colours the five rarities and nothing in the file uses an em dash', () => {
    for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary']) expect(css).toContain(`[data-rarity='${r}']`);
    expect(css).not.toMatch(/\u2014/);
  });
});

describe('packs-list.css: the demo pack is one large centred card', () => {
  const list = fs.readFileSync(path.resolve(__dirname, '../packs-list.css'), 'utf8');
  it('the demo grid centres its card (flex, centred) and the card is capped near 880 px, not stretched to an empty side column', () => {
    expect(list).toMatch(/\.pl-grid--demo \{[^}]*display: flex[^}]*justify-content: center/);
    expect(list).toMatch(/\.pl-grid--demo > \.pl-card \{[^}]*max-width: 880px/);
    expect(list).toMatch(/\.pl-group--demo \{ text-align: center; \}/);
  });
  it('has no em dash', () => { expect(list).not.toMatch(/\u2014/); });
});
