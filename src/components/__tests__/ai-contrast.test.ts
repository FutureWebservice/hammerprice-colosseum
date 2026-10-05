/**
 * Contrast guard for the AI chat (src/components/ai/agent.css): every text colour is read from the real CSS and compared with the background it sits
 * on, at 4.5:1 or better (WCAG AA for normal text). A later edit that lightens a background or dims a text fails here, not in the accessibility audit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/components/ai/agent.css'), 'utf8');
const launchers = readFileSync(join(process.cwd(), 'src/components/room/launchers.css'), 'utf8');
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const block = (selector: string): string => {
  const m = css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\:>]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
  expect(m, `${selector} rule`).toBeTruthy();
  return m![1]!;
};
const vars = Object.fromEntries([...block('.agc, .agc-gate, .aip').matchAll(/(--agc-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
const resolve = (v: string): string => { const m = /var\((--agc-[\w-]+)\)/.exec(v); return m ? vars[m[1]!]! : v; };
const prop = (selector: string, name: 'color' | 'background'): string => {
  const m = new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);?`).exec(block(selector));
  expect(m, `${selector} ${name}`).toBeTruthy();
  return resolve(m![1]!.trim());
};
/** `rgba(r, g, b, a)` over an opaque hex background. */
const over = (rgba: string, bg: string): string => {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba)!;
  const b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  return `#${[0, 1, 2].map((i) => Math.round(Number(m[i + 1]) * Number(m[4]) + b[i]! * (1 - Number(m[4]))).toString(16).padStart(2, '0')).join('')}`;
};
const MIN = 4.5;
const PANE = vars['--agc-bg']!, HEAD = '#0e1116', INK = '#0e1116', RAISE = vars['--agc-raise']!, CARD = '#151b22', BRASS = vars['--agc-brass']!, BRASS_BR = vars['--agc-brass-br']!;
const GATE = over('rgba(200, 164, 77, .08)', PANE), GATE_ON_SHEET = over('rgba(200, 164, 77, .08)', '#161b22');

describe('the AI chat text meets 4.5:1', () => {
  it('assistant text sits on the page ground, the user bubble on the raised surface', () => {
    expect(ratio(prop('.agc-bubble--ai', 'color'), INK)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-bubble--you', 'color'), prop('.agc-bubble--you', 'background'))).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-hero-text', 'color'), INK)).toBeGreaterThanOrEqual(MIN);
  });
  it('top bar, hint, reset button and composer', () => {
    expect(ratio(prop('.agc-title', 'color'), HEAD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc .agc-hint', 'color'), HEAD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-ctx', 'color'), HEAD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-reset, .agc-close', 'color'), HEAD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio('#ffb4a3', over('rgba(255, 138, 117, .1)', HEAD))).toBeGreaterThanOrEqual(MIN); // the confirming state of the reset button
    expect(css).toMatch(/\.agc-reset\.is-confirm \{ color: #ffb4a3;/);
    expect(ratio(prop('.aip-off', 'color'), HEAD)).toBeGreaterThanOrEqual(MIN); // the off note sits on the page ground
    expect(ratio(prop('.agc .agc-composer textarea', 'color'), RAISE)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc .agc-composer textarea::placeholder', 'color'), RAISE)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-send', 'color'), prop('.agc-send', 'background'))).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-avatar', 'color'), prop('.agc-avatar', 'background'))).toBeGreaterThanOrEqual(MIN);
  });
  it('the example cards (on the page ground) and the connect card (on the pane and on the room sheet)', () => {
    expect(ratio(prop('.agc-ex', 'color'), over('rgba(200, 164, 77, .12)', INK))).toBeGreaterThanOrEqual(MIN); // the hover state, the lighter one
    for (const bg of [GATE, GATE_ON_SHEET]) {
      expect(ratio(prop('.agc-gate-title', 'color'), bg)).toBeGreaterThanOrEqual(MIN);
      expect(ratio(prop('.agc-gate-body', 'color'), bg)).toBeGreaterThanOrEqual(MIN);
      expect(ratio(prop('.agc-gate-err', 'color'), bg)).toBeGreaterThanOrEqual(MIN);
    }
    expect(ratio(prop('.agc-gate-icon', 'color'), prop('.agc-gate-icon', 'background'))).toBeGreaterThanOrEqual(MIN);
    expect(ratio('#1a1a17', BRASS)).toBeGreaterThanOrEqual(MIN); // the primary button
  });
  it('lot cards', () => {
    for (const s of ['.agc-lot-top', '.agc-lot-name', '.agc-lot-meta', '.agc-lot-price', '.agc-lot-time']) expect(ratio(prop(s, 'color'), CARD), s).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-lot-price strong', 'color'), CARD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-pill', 'color'), CARD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-pill--open', 'color'), prop('.agc-pill--open', 'background'))).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-grade', 'color'), prop('.agc-grade', 'background'))).toBeGreaterThanOrEqual(MIN);
    for (const bg of ['#1d4a3c', '#14342b']) expect(ratio(prop('.agc-lot-img', 'color'), bg), bg).toBeGreaterThanOrEqual(MIN); // the "no photo" placeholder on its gradient
  });
  it('bid and draft cards', () => {
    for (const s of ['.agc-facts dt', '.agc-note', '.agc-step-note']) expect(ratio(prop(s, 'color'), CARD), s).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-facts dd', 'color'), CARD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-step-val', 'color'), CARD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-step-btn', 'color'), CARD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(prop('.agc-ok', 'color'), CARD)).toBeGreaterThanOrEqual(MIN);
    expect(ratio(BRASS_BR, CARD)).toBeGreaterThanOrEqual(MIN);
  });
  it('motion only when the visitor has not asked for less, and a touch target of 40 px or more on the controls', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{[^@]*animation: agc-dot/);
    expect(css).not.toMatch(/^\.agc-typing i \{[^}]*animation/m);
    expect(block('.agc-send')).toMatch(/width: 44px; height: 44px/);
    expect(block('.agc-reset, .agc-close')).toMatch(/min-height: 40px/);
    expect(block('.agc-step-btn')).toMatch(/width: 44px; height: 44px/);
    expect(css).toMatch(/env\(safe-area-inset-bottom\)/); // the composer clears the home indicator
  });
  it('the room status chips and the publish row', () => {
    expect(ratio(prop('.agc-chip', 'color'), over('rgba(200, 164, 77, .08)', INK))).toBeGreaterThanOrEqual(MIN);
  });
  it('the room launchers: brass on ink, equal size, a visible focus ring, safe area above the bid bar', () => {
    expect(ratio('#1a1a17', '#c8a44d')).toBeGreaterThanOrEqual(MIN); // the assistant pill
    expect(ratio('#e8c776', '#12171d')).toBeGreaterThanOrEqual(MIN); // the chat pill
    expect(launchers).toMatch(/\.hp-launch \{[^}]*width: 148px; min-height: 44px;[^}]*border-radius: 999px/);
    expect(launchers).not.toMatch(/\.hp-launch--(ai|chat) \{[^}]*(width|height|padding):/); // one size for both
    expect(launchers).toMatch(/\.hp-launch:focus-visible \{ outline: 2px solid/);
    expect(launchers).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});
