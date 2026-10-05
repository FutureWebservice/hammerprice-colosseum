/** The poll beat of a timed lot (src/lib/client/live.ts): slow while it is hours away, 1 s only in the last 2 minutes; a live room keeps its 1 s. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveSnapshot } from '@/contracts';
import { createLivePoller, pollDelayMs, timedPollMs, POLL_IDLE_MS, POLL_OPEN_MS } from '@/lib/client/live';

const MIN = 60_000;
const open = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../contracts/fixtures/live-snapshot.open.json'), 'utf8')) as LiveSnapshot;

describe('timedPollMs', () => {
  it('5 s over 10 minutes out, 2 s from 10 minutes, 1 s from 2 minutes', () => {
    expect(timedPollMs(3 * 24 * 60 * MIN)).toBe(5000);
    expect(timedPollMs(10 * MIN + 1)).toBe(5000);
    expect(timedPollMs(10 * MIN)).toBe(2000);
    expect(timedPollMs(2 * MIN + 1)).toBe(2000);
    expect(timedPollMs(2 * MIN)).toBe(1000);
    expect(timedPollMs(5000)).toBe(1000);
    expect(timedPollMs(-10)).toBe(1000);
  });
});

describe('pollDelayMs', () => {
  it('a live lot is unchanged: no timedLeftMs, 1 s open, 5 s otherwise', () => {
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0 })).toBe(POLL_OPEN_MS);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0, timedLeftMs: null })).toBe(POLL_OPEN_MS);
    expect(pollDelayMs({ lotOpen: false, errorStreak: 0 })).toBe(POLL_IDLE_MS);
  });
  it('a timed lot follows the time left; errors still back off from that base; a closed lot is the idle beat', () => {
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0, timedLeftMs: 3600_000 })).toBe(5000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0, timedLeftMs: 5 * MIN })).toBe(2000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0, timedLeftMs: MIN })).toBe(1000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 1, timedLeftMs: MIN })).toBe(2000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 5, timedLeftMs: 3600_000 })).toBe(10_000);
    expect(pollDelayMs({ lotOpen: false, errorStreak: 0, timedLeftMs: 3600_000 })).toBe(POLL_IDLE_MS);
  });
});

describe('the poller schedules by kind and time left', () => {
  const snapshotWith = (kind: 'live' | 'timed', leftMs: number): LiveSnapshot => ({
    ...open, show: { ...open.show, kind }, current: { ...open.current!, phase: 'open', closesAt: new Date(open.serverNow + leftMs).toISOString() },
  });

  async function firstDelay(snapshot: LiveSnapshot): Promise<number> {
    const delays: number[] = [];
    const poller = createLivePoller({
      showId: snapshot.show.id,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => snapshot })) as unknown as typeof fetch,
      onState: () => {},
      now: () => snapshot.serverNow,
      setTimer: (_fn, ms) => { delays.push(ms); return delays.length; },
      clearTimer: () => {},
      random: () => 0.5,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    return delays[0];
  }

  it('a timed lot with 3 hours left: 5 s', async () => expect(await firstDelay(snapshotWith('timed', 3 * 60 * MIN))).toBe(5000));
  it('a timed lot with 5 minutes left: 2 s', async () => expect(await firstDelay(snapshotWith('timed', 5 * MIN))).toBe(2000));
  it('a timed lot with 90 seconds left: 1 s', async () => expect(await firstDelay(snapshotWith('timed', 90_000))).toBe(1000));
  it('a live lot with 3 hours left (cannot happen, but) keeps the 1 s beat', async () => expect(await firstDelay(snapshotWith('live', 3 * 60 * MIN))).toBe(1000));
});
