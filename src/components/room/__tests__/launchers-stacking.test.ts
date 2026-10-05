/**
 * Guard for the launcher stacking: the Assistant / Chat pills must never paint over an open chat panel or assistant drawer
 * (real phones showed the Assistant button on top of the chat sheet). Read from the real CSS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const launchers = read('src/components/room/launchers.css');
const chat = read('src/components/chat/chat.css');
const z = (css: string, selector: string): number => {
  const m = css.match(new RegExp(`^${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'm'));
  expect(m, `${selector} rule`).toBeTruthy();
  return Number(/z-index:\s*(\d+)/.exec(m![1]!)![1]);
};

describe('launcher stacking', () => {
  it('the launchers sit below the chat panel, the assistant drawer and its scrim', () => {
    const launch = z(launchers, '.hp-launch');
    expect(launch).toBeLessThan(z(chat, '.hc-root'));
    expect(launch).toBeLessThan(z(launchers, '.hp-assist-drawer'));
    expect(launch).toBeLessThan(47); // the scrim
  });
  it('on a phone both launchers are hidden while the chat panel or the assistant drawer is open', () => {
    const m = /@media \(max-width: 980px\) \{[\s\S]*?body:has\(\.hc-panel, \.hp-assist-drawer:not\(\[hidden\]\)\) \.hp-launch \{ display: none; \}/.exec(launchers);
    expect(m).toBeTruthy();
  });
  it('on a desktop the launchers never hide: they move right of the open chat sidebar instead (the chat one then reads Close chat)', () => {
    expect(launchers).toMatch(/body:has\(\.hc-panel\) \{ --hp-launch-x: calc\(var\(--hp-chat-w\) \+ 16px\); \}/);
    expect(launchers).not.toMatch(/@media \(min-width: 981px\)[^@]*\.hp-launch \{ display: none/);
    expect(read('src/components/room/slots/SideChat.tsx')).toMatch(/launcher\.closeShort/);
  });
});
