/**
 * Layout guard for the room's two sidebars (read from the real CSS, no browser): the chat is the left one, the assistant the right one, they never
 * overlap each other, and the stage keeps a usable width with both open at 1280 and 1920 px. On a phone each is a 100dvh sheet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const launchers = read('src/components/room/launchers.css');
const chat = read('src/components/chat/chat.css');
const auction = read('src/components/auction/auction.css');
const px = (css: string, name: string): number => {
  const m = new RegExp(`${name}:?\\s*(\\d+)px`).exec(css);
  expect(m, name).toBeTruthy();
  return Number(m![1]);
};
const rule = (css: string, selector: string): string => {
  const m = css.match(new RegExp(`^${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`, 'm'));
  expect(m, `${selector} rule`).toBeTruthy();
  return m![1]!;
};

const CHAT_W = px(launchers, '--hp-chat-w');
const ASSIST_W = px(launchers, '--hp-assist-w');
const CAT_W = px(auction, 'var\\(--ar-cat-w,');
const FEED_W = px(auction, 'var\\(--ar-feed-w,');
const MIN_STAGE = 480;

/** The stage's width by the CSS rules: a rail folds away (0) when a sidebar is open on its side below 1920 px, and both whenever one is open below 1280 px. */
function stage(vw: number, chatOpen: boolean, assistOpen: boolean): number {
  const room = vw - (chatOpen ? CHAT_W : 0) - (assistOpen ? ASSIST_W : 0);
  const anyBelow1280 = vw < 1280 && (chatOpen || assistOpen);
  const cat = (chatOpen && vw < 1920) || anyBelow1280 ? 0 : CAT_W;
  const feed = (assistOpen && vw < 1920) || anyBelow1280 ? 0 : FEED_W;
  return room - cat - feed;
}

describe('room sidebars: desktop layout', () => {
  it('the chat is fixed at the left edge, the assistant at the right edge, both under the site header and full height', () => {
    const c = rule(chat, '.hc-panel');
    expect(c).toMatch(/position: fixed/);
    expect(c).toMatch(/left: 0/);
    expect(c).not.toMatch(/[;\s]right:/);
    expect(c).toMatch(/top: var\(--hp-bar-h/);
    expect(c).toMatch(/bottom: 0/);
    expect(c).toMatch(/width: var\(--hp-chat-w/);
    const a = rule(launchers, '.hp-assist-drawer');
    expect(a).toMatch(/right: 0/);
    expect(a).not.toMatch(/[;\s]left:/);
    expect(a).toMatch(/top: var\(--hp-bar-h/);
    expect(a).toMatch(/bottom: 0/);
    expect(a).toMatch(/width: min\(var\(--hp-assist-w\)/);
  });
  it('the two sidebars are the same width class (360 to 400 px)', () => {
    for (const w of [CHAT_W, ASSIST_W]) { expect(w).toBeGreaterThanOrEqual(360); expect(w).toBeLessThanOrEqual(400); }
  });
  it('at 1280 and 1920 px both can be open without touching, and the stage keeps its minimum', () => {
    for (const vw of [1280, 1440, 1920]) {
      expect(CHAT_W + ASSIST_W, `${vw} px: no overlap`).toBeLessThanOrEqual(vw);
      expect(stage(vw, true, true), `${vw} px both open`).toBeGreaterThanOrEqual(MIN_STAGE);
    }
    for (const vw of [981, 1100, 1279]) {
      expect(stage(vw, true, false), `${vw} px chat only`).toBeGreaterThanOrEqual(MIN_STAGE);
      expect(stage(vw, false, true), `${vw} px assistant only`).toBeGreaterThanOrEqual(MIN_STAGE);
    }
  });
  it('the room takes the sidebars width as padding and the rails fold away as the arithmetic assumes', () => {
    expect(launchers).toMatch(/body:has\(\.hc-panel\) \.hp\.ar-room \{ padding-left: var\(--hp-chat-w\); \}/);
    expect(launchers).toMatch(/body:has\(\.hp-assist-drawer:not\(\[hidden\]\)\) \.hp\.ar-room \{ padding-right: var\(--hp-assist-w\); \}/);
    expect(launchers).toMatch(/@media \(min-width: 981px\) and \(max-width: 1919px\) \{[\s\S]*body:has\(\.hc-panel\) \.ar-rostrum \{ --ar-cat-w: 0px; \}[\s\S]*\.ar-feed \{ visibility: hidden; \}/);
    expect(launchers).toMatch(/@media \(min-width: 981px\) and \(max-width: 1279px\) \{[\s\S]*--ar-cat-w: 0px; --ar-feed-w: 0px;/);
  });
  it('the launchers move right of the chat sidebar while it is open (they never cover it), and the moderation popup moves with them', () => {
    expect(launchers).toMatch(/@media \(min-width: 981px\) \{\s*body:has\(\.hc-panel\) \{ --hp-launch-x: calc\(var\(--hp-chat-w\) \+ 16px\); \}/);
    expect(chat).toMatch(/@media \(min-width: 981px\) \{ body:has\(\.hc-panel\) \.hc-toast-wrap \{ left: calc\(var\(--hp-chat-w, 380px\) \+ 16px\); \} \}/);
    expect(rule(chat, '.hc-toast-wrap')).toMatch(/top: calc\(var\(--hp-bar-h/); // top of the room, not the bottom left where the launchers are
  });
});

describe('room sidebars: phone', () => {
  it('both are full screen sheets (100dvh) with the safe area, and the launchers and the bubble step aside', () => {
    expect(chat).toMatch(/@media \(max-width: 980px\) \{[\s\S]*\.hc-panel \{ top: 0; right: 0; width: auto; max-width: none; height: 100dvh;[^}]*env\(safe-area-inset-top\)/);
    expect(launchers).toMatch(/\.hp-assist-drawer \{ top: 0; left: 0; right: 0; width: auto; height: 100dvh;[^}]*env\(safe-area-inset-top\)/);
    expect(launchers).toMatch(/body:has\(\.hc-panel, \.hp-assist-drawer:not\(\[hidden\]\)\) \.hp-launch \{ display: none; \}/);
    expect(launchers).toMatch(/body:has\(\.hc-panel, \.hp-assist-drawer:not\(\[hidden\]\)\) :is\(\.ex-bubble, \.ux-tour\) \{ display: none; \}/);
  });
  it('the chat sheet rises above the site header (z 46) on a phone', () => {
    expect(chat).toMatch(/body:has\(\.hc-panel\) \.hc-root \{ z-index: 48; \}/);
  });
});
