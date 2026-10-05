/**
 * K15: one click on a wallet is one connect attempt. A rejected Phantom popup must not be followed by an automatic second one.
 * The sequence below replays what the provider reports around one click, through the same decision the picker's effect uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterPick, autoConnectStep, type AfterPickState, type AutoConnectState } from '../walletConnect';

const base: AutoConnectState = { picked: 'Phantom', selected: 'Phantom', connected: false, connecting: false, attempt: 1, used: 0 };

describe('autoConnectStep', () => {
  it('connects once for a click when the picked wallet is selected and idle', () => {
    expect(autoConnectStep(base)).toBe('connect');
  });
  it('waits before any click, for the wrong selected wallet, and when already connected', () => {
    expect(autoConnectStep({ ...base, picked: null, attempt: 0 })).toBe('wait');
    expect(autoConnectStep({ ...base, selected: 'Solflare' })).toBe('wait');
    expect(autoConnectStep({ ...base, selected: null })).toBe('wait');
    expect(autoConnectStep({ ...base, connected: true })).toBe('wait');
  });
  it('uses the attempt up when the provider is already connecting by itself, without calling connect', () => {
    expect(autoConnectStep({ ...base, connecting: true })).toBe('consumed');
  });

  it('does not ask again after a rejection (connecting true, then false, still not connected)', () => {
    let used = 0;
    let calls = 0;
    const run = (s: Omit<AutoConnectState, 'used'>) => {
      const step = autoConnectStep({ ...s, used });
      if (step !== 'wait') used = s.attempt;
      if (step === 'connect') calls++;
    };
    const idle = { picked: 'Phantom', selected: 'Phantom', connected: false, connecting: false, attempt: 1 };
    run(idle);                              // click: connect() is called
    run({ ...idle, connecting: true });     // the popup is open
    run(idle);                              // the person rejected it: connecting is false again, not connected
    run(idle);                              // any later re-render
    expect(calls).toBe(1);
    run({ ...idle, attempt: 2 });           // the person clicks again
    expect(calls).toBe(2);
    run({ ...idle, attempt: 2 });
    expect(calls).toBe(2);
  });

  it('does not ask a second time when the provider auto-connects and the person rejects that popup', () => {
    let used = 0;
    let calls = 0;
    const run = (s: Omit<AutoConnectState, 'used'>) => {
      const step = autoConnectStep({ ...s, used });
      if (step !== 'wait') used = s.attempt;
      if (step === 'connect') calls++;
    };
    const s = { picked: 'Phantom', selected: 'Phantom', connected: false, attempt: 1 };
    run({ ...s, connecting: true });        // the provider's own autoConnect started
    run({ ...s, connecting: false });       // rejected
    expect(calls).toBe(0);
  });
});

/** Connect, then Sign in was two clicks for one wish. A picked wallet now goes on into the signature by itself; a restored one and a phone do not. */
describe('afterPick', () => {
  const picked: AfterPickState = { wanted: true, looked: true, anonymous: true, mobile: false };
  it('signs when the picked wallet is connected, looked up and has no session', () => {
    expect(afterPick(picked)).toBe('sign');
  });
  it('waits while nothing was picked (a wallet the adapter restored by itself) or the session lookup still runs', () => {
    expect(afterPick({ ...picked, wanted: false })).toBe('wait');
    expect(afterPick({ ...picked, looked: false })).toBe('wait');
  });
  it('drops the wish without signing when a session exists already or on a phone (it keeps the tap on Sign in)', () => {
    expect(afterPick({ ...picked, anonymous: false })).toBe('drop');
    expect(afterPick({ ...picked, mobile: true })).toBe('drop');
  });
  it('asks the wallet once per click: a rejected or failed signature is followed by the retry button, not by another prompt', () => {
    let wanted = true;
    let signs = 0;
    const tick = (s: Omit<AfterPickState, 'wanted'>) => {
      const step = afterPick({ ...s, wanted });
      if (step !== 'wait') wanted = false;
      if (step === 'sign') signs++;
    };
    const lookedUp = { looked: true, anonymous: true, mobile: false };
    tick({ ...lookedUp, looked: false }); // connected, /api/me still running
    tick(lookedUp);                       // no session: sign
    tick(lookedUp);                       // rejected: anonymous again, same render inputs
    tick(lookedUp);
    expect(signs).toBe(1);
  });
});

describe('the connect flows carry a pick on', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  it('the header, gate and pack buttons open the sheet that asks for the sign-in after the pick', () => {
    expect(read('src/components/room/ConnectWalletButton.tsx')).toContain('onPick={wantSignIn}');
  });
  it('a click on a wallet clears an old wish before its own caller sets a new one', () => {
    expect(read('src/components/room/WalletSheet.tsx')).toMatch(/wantSignIn\(false\); onPick\?\.\(\);/);
  });
  it('the session and the Get ready sheet both decide through afterPick', () => {
    expect(read('src/components/auth/SessionProvider.tsx')).toContain('afterPick(');
    expect(read('src/components/room/GetReadySheet.tsx')).toContain('afterPick(');
    expect(read('src/components/room/GetReadySheet.tsx')).toContain('onPick={() => { picked.current = true; }}');
  });
});

describe('WalletSheet wiring', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/components/room/WalletSheet.tsx'), 'utf8');
  it('counts clicks and routes the effect through autoConnectStep (no bare connect() on every connecting change)', () => {
    expect(src).toContain('autoConnectStep(');
    expect(src).toContain('setAttempt((n) => n + 1)');
    expect(src).not.toMatch(/!connected && !connecting\) void connect\(\)/);
  });
});
