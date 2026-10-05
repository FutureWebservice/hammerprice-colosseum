/**
 * Contrast guard for the text that axe flagged on the cream paper (WP-Q3): the landing lot "set" line, the room catalogue's
 * lot-duration note and its "limit met" line. Reads the real CSS, so a later edit that drops the colour or lets a more
 * specific rule win again fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = (f: string) => readFileSync(join(process.cwd(), 'src/components', f), 'utf8');
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rule = (src: string, selector: string) => {
  const m = src.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
  expect(m, `${selector} rule`).toBeTruthy();
  return m![1];
};
const color = (body: string) => body.match(/(?:^|[;\s])color:\s*(#[0-9a-f]{6})/i)?.[1] ?? '';

describe('paper text meets 4.5:1', () => {
  it('landing lot set line beats `.hp-sec p` (specificity) and uses the muted ink', () => {
    const land = css('landing/hammerprice.css');
    expect(land).toMatch(/^\.hp-lot \.hp-lot-set \{/m); // two classes: wins over `.hp-sec p`
    expect(land).toMatch(/--ink-muted: (#[0-9a-f]{6})/i);
    const muted = land.match(/--ink-muted: (#[0-9a-f]{6})/i)![1];
    expect(ratio(muted, '#f4f0e6')).toBeGreaterThanOrEqual(4.5);
  });
  it('the landing sheet entrance never dims the text (opacity < 1 below the fold fails axe and Lighthouse)', () => {
    expect(css('landing/hammerprice.css')).not.toMatch(/@keyframes hp-sheet-rise \{[^}]*opacity/);
  });
  it('room catalogue rule note and limit-met line', () => {
    const a = css('auction/auction.css');
    expect(ratio(color(rule(a, '.ar-cat-rule')), '#f4f0e6')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color(rule(a, '.ar-cat-lot .ar-limit.is-met')), '#fbf8ee')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('shared surface kit (ui/hpx.css, rooms list, room bid bar) meets 4.5:1', () => {
  const hpx = css('ui/hpx.css');
  const TOKENS: Record<string, string> = { '--brass-br': '#e8c776', '--brass': '#c8a44d', '--paper': '#f4f0e6', '--slate': '#9aa3b2' };
  const color = (body: string) => {
    const m = body.match(/(?:^|[;\s])color:\s*(#[0-9a-f]{6}|var\((--[a-z-]+)\))/i);
    return m ? (m[2] ? TOKENS[m[2]] : m[1]) : '';
  };
  const INK = '#0e1116';
  const GLASS = '#1a1e24'; // ink with the 3.5 percent white glass on top, rounded up
  it('primary button, chips and the secondary outline button', () => {
    expect(ratio(color(rule(hpx, '.hpx-btn')), '#e8c776')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color(rule(hpx, '.hpx-chip--demo')), '#e8c776')).toBeGreaterThanOrEqual(4.5);
    for (const sel of ['.hpx-chip', '.hpx-chip--gold', '.hpx-chip--live', '.hpx-chip--dim', '.hpx-btn--ghost']) {
      expect(ratio(color(rule(hpx, sel)), GLASS), sel).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('the room bid bar: Bid button, standing chips, quick raises', () => {
    const a = css('auction/auction.css');
    expect(ratio(color(rule(a, '.ar-bidbtn')), '#e8c776')).toBeGreaterThanOrEqual(4.5);
    for (const sel of ['.ar-paddle-status.is-leading', '.ar-paddle-status.is-outbid', '.ar-paddle-status.is-lost', '.ar-paddle', '.ar-quick-label', '.ar-live', '.ar-status-pill']) {
      expect(ratio(color(rule(a, sel)), INK), sel).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(color(rule(a, '.ar-paddle-status.is-won')), '#e8c776')).toBeGreaterThanOrEqual(4.5);
  });
});
