/**
 * Paint guard (read from the real CSS, no browser) for the "empty black sidebar / black card" report: an open sidebar and the stage card can never be left
 * invisible. Both sidebars have a minimum height and are never display:none or visibility:hidden while open; none of the entrance animations starts at
 * opacity 0 (so the resting, fully visible state is what is painted even when the animation never runs); the stage card carries no CSS filter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const chat = read('src/components/chat/chat.css');
const launchers = read('src/components/room/launchers.css');
const auction = read('src/components/auction/auction.css');

const rule = (css: string, selector: string): string => {
  const m = css.match(new RegExp(`^${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`, 'm'));
  expect(m, `${selector} rule`).toBeTruthy();
  return m![1]!;
};
const keyframes = (css: string, name: string): string => {
  const i = css.indexOf(`@keyframes ${name} {`);
  expect(i, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('\n', i));
};

describe('open sidebars are painted', () => {
  for (const [name, css, sel] of [['chat', chat, '.hc-panel'], ['assistant', launchers, '.hp-assist-drawer']] as const) {
    it(`${name}: a minimum height, shown, opaque`, () => {
      const r = rule(css, sel);
      expect(r).toMatch(/min-height: \d{3,}px/);
      expect(r).not.toMatch(/display:\s*none/);
      expect(r).not.toMatch(/visibility:\s*hidden/);
      expect(r).not.toMatch(/opacity:\s*0/);
      expect(r).toMatch(/background: #0e1116/);
    });
  }
  it('the assistant drawer is hidden only through the hidden attribute (closed), never by default', () => {
    expect(launchers).toMatch(/\.hp-assist-drawer\[hidden\] \{ display: none; \}/);
  });
  it('no entrance animation starts transparent: the sidebars and the stage card slide or scale only', () => {
    for (const [css, name] of [[chat, 'hc-in'], [chat, 'hc-up'], [launchers, 'hp-assist-in'], [launchers, 'hp-assist-up'], [auction, 'ar-stage-card-enter']] as const) {
      expect(keyframes(css, name), name).not.toMatch(/opacity/);
    }
  });
  it('the stage card has no CSS filter (a filtered, animated image painted as a black silhouette); its glow is a box-shadow', () => {
    const r = rule(auction, '.ar-stage-card').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(r).not.toMatch(/filter/);
    expect(r).toMatch(/box-shadow/);
  });
  it('the chat gate card and the skeleton are styled', () => {
    for (const s of ['.hc-gate', '.hc-skel', '.hc-skel-bar']) expect(chat).toContain(`${s} {`);
  });
});
