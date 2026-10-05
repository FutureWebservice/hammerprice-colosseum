import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveSnapshot, SnapshotEvent } from '@/contracts';
import {
  createLivePoller, extensionSeconds, fetchSnapshot, isLotOpen, isOverdue, isPaused, lotMsLeft, mergeEvents, mergeSnapshot, pollDelayMs, LiveError, type PollerState,
} from '../live';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../../contracts/fixtures', `${n}.json`), 'utf8')) as LiveSnapshot;
const open = fx('live-snapshot.open');
const settled = fx('live-snapshot.settled');
const ev = (id: number): SnapshotEvent => ({ id, kind: 'show.live', at: '2026-10-05T18:00:00.000Z', payload: {} });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as Response;

describe('pure helpers', () => {
  it('polls at 1 s while a lot is open and 5 s otherwise, doubling on errors up to 10 s', () => {
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0 })).toBe(1000);
    expect(pollDelayMs({ lotOpen: false, errorStreak: 0 })).toBe(5000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 1 })).toBe(2000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 2 })).toBe(4000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 9 })).toBe(10000);
    expect(pollDelayMs({ lotOpen: false, errorStreak: 3 })).toBe(10000);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0, random: 0 })).toBe(900);
    expect(pollDelayMs({ lotOpen: true, errorStreak: 0, random: 1 })).toBe(1100);
  });

  it('knows when a lot is open', () => {
    expect(isLotOpen(open)).toBe(true);
    expect(isLotOpen(settled)).toBe(false);
    expect(isLotOpen(null)).toBe(false);
  });

  it('never rolls the screen back', () => {
    const older = { ...open, lastEventId: open.lastEventId - 1 };
    expect(mergeSnapshot(open, older)).toBe(open);
    const staleClock = { ...open, serverNow: open.serverNow - 1 };
    expect(mergeSnapshot(open, staleClock)).toBe(open);
    const newer = { ...open, lastEventId: open.lastEventId + 1, serverNow: open.serverNow + 1000 };
    expect(mergeSnapshot(open, newer)).toBe(newer);
    expect(mergeSnapshot(null, open)).toBe(open);
    expect(mergeSnapshot(open, { ...settled, show: { ...settled.show, id: '00000000-0000-4000-8000-000000000001' } }).show.id).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('dedupes events by id, not by array length (C5)', () => {
    const first = mergeEvents([], [ev(1), ev(2), ev(3)]);
    expect(first.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(mergeEvents(first, [ev(2), ev(3)])).toBe(first); // nothing new: same reference
    expect(mergeEvents(first, [ev(3), ev(4), ev(2)]).map((e) => e.id)).toEqual([1, 2, 3, 4]);
    // past the old 200 cap the newest events keep arriving
    let all: SnapshotEvent[] = [];
    for (let i = 1; i <= 260; i++) all = mergeEvents(all, [ev(i)]);
    expect(all).toHaveLength(200);
    expect(all.at(-1)!.id).toBe(260);
    expect(all[0]!.id).toBe(61);
  });

  it('detects an overdue lot and an anti-snipe extension', () => {
    const closes = Date.parse(open.current!.closesAt!);
    expect(isOverdue(open, 0, closes - 1)).toBe(false);
    expect(isOverdue(open, 0, closes + 1)).toBe(true);
    expect(isOverdue(settled, 0, closes + 1e9)).toBe(false);
    const extended = { ...open, current: { ...open.current!, closesAt: new Date(closes + 15_000).toISOString() } };
    expect(extensionSeconds(open, extended)).toBe(15);
    expect(extensionSeconds(extended, open)).toBe(0);
    expect(extensionSeconds(null, open)).toBe(0);
    const otherLot = { ...extended, current: { ...extended.current!, lotId: '5d2e9f63-7c14-4b8a-9e05-3a6b1c8d4f12' } };
    expect(extensionSeconds(open, otherLot)).toBe(0);
  });
});

describe('fetchSnapshot', () => {
  it('validates the contract and reports the failure kind', async () => {
    const f = vi.fn().mockResolvedValue(ok(open));
    const r = await fetchSnapshot('show-1', f as unknown as typeof fetch, () => 5);
    expect(r.snapshot.lastEventId).toBe(103);
    expect(f.mock.calls[0]![0]).toBe('/api/auctions/show-1/live');
    await expect(fetchSnapshot('x', vi.fn().mockResolvedValue(status(404)) as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(fetchSnapshot('x', vi.fn().mockResolvedValue(status(500)) as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'http' });
    await expect(fetchSnapshot('x', vi.fn().mockResolvedValue(ok({ v: 2 })) as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'shape' });
    await expect(fetchSnapshot('x', vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)).rejects.toBeInstanceOf(LiveError);
  });
});

describe('poller loop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(responses: Array<() => Promise<Response>>, hidden = { v: false }) {
    const states: PollerState[] = [];
    let visible: (() => void) | null = null;
    let i = 0;
    const fetchImpl = vi.fn(() => responses[Math.min(i++, responses.length - 1)]!());
    const poller = createLivePoller({
      showId: 's1', fetchImpl: fetchImpl as unknown as typeof fetch, onState: (s) => states.push(s), random: () => 0.5,
      now: () => Date.now(), isHidden: () => hidden.v, onVisible: (cb) => { visible = cb; return () => { visible = null; }; },
    });
    return { poller, states, fetchImpl, hidden, fire: () => visible?.() };
  }

  it('polls every second while a lot is open, and applies the clock offset from the response', async () => {
    vi.setSystemTime(open.serverNow - 50);
    const h = harness([async () => ok(open)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.poller.state.status).toBe('ready');
    expect(Math.abs(h.poller.state.offset - 50)).toBeLessThan(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(4);
    h.poller.stop();
  });

  it('slows to 5 s when no lot is open', async () => {
    vi.setSystemTime(settled.serverNow);
    const h = harness([async () => ok(settled)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4900);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });

  it('pauses while the tab is hidden and polls at once when it returns', async () => {
    vi.setSystemTime(open.serverNow);
    const h = harness([async () => ok(open)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.hidden.v = true;
    await vi.advanceTimersByTimeAsync(1000); // the pending timer fires once, sees no schedule after it
    const callsWhenHidden = h.fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl.mock.calls.length).toBe(callsWhenHidden + 0);
    h.hidden.v = false;
    h.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchImpl.mock.calls.length).toBe(callsWhenHidden + 1);
    h.poller.stop();
  });

  it('backs off on errors, keeps the last snapshot, and recovers', async () => {
    vi.setSystemTime(open.serverNow);
    const h = harness([async () => ok(open), async () => status(500), async () => status(500), async () => ok(open)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); // second call fails
    expect(h.poller.state.errorStreak).toBe(1);
    expect(h.poller.state.status).toBe('ready');
    expect(h.poller.state.snapshot).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1900);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2); // next retry waits 2 s, not 1 s
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.poller.state.errorStreak).toBe(2);
    await vi.advanceTimersByTimeAsync(4100);
    expect(h.poller.state.errorStreak).toBe(0);
    h.poller.stop();
  });

  it('stops on 404 and reports not found; shows error before any snapshot exists', async () => {
    const h = harness([async () => status(404)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.poller.state.status).toBe('notfound');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const h2 = harness([async () => status(500)]);
    h2.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h2.poller.state.status).toBe('error');
    h2.poller.stop();
  });

  it('re-polls once, quickly, when the lot is overdue but still reported open', async () => {
    vi.setSystemTime(Date.parse(open.current!.closesAt!) + 500);
    const late = { ...open, serverNow: Date.parse(open.current!.closesAt!) + 500 };
    const h = harness([async () => ok(late)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    // not again at 250 ms for the same deadline: back to the normal 1 s cadence
    await vi.advanceTimersByTimeAsync(300);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });

  it('merges the snapshot carried by the viewer\'s own bid response without rolling back', async () => {
    vi.setSystemTime(open.serverNow);
    const h = harness([async () => ok(open)]);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const newer: LiveSnapshot = { ...open, serverNow: open.serverNow + 500, lastEventId: 104, events: [...open.events, ev(104)] };
    h.poller.applySnapshot(newer);
    expect(h.poller.state.snapshot!.lastEventId).toBe(104);
    h.poller.applySnapshot(open); // the slower cached poll arrives late
    expect(h.poller.state.snapshot!.lastEventId).toBe(104);
    expect(h.poller.state.events.map((e) => e.id)).toEqual([101, 102, 103, 104]);
    h.poller.stop();
  });
});

describe('the seller\'s pause on the client', () => {
  const paused = fx('live-snapshot.paused');
  const closes = Date.parse(paused.current!.closesAt!);
  const pausedAt = Date.parse(paused.show.pause.pausedAt!);

  it('knows a paused room, and treats a snapshot without the field as running', () => {
    expect(isPaused(paused)).toBe(true);
    expect(isPaused(open)).toBe(false);
    expect(isPaused(null)).toBe(false);
  });

  it('draws the same frozen time for everyone however much later they look: closesAt minus the moment of the pause', () => {
    expect(lotMsLeft(paused, pausedAt)).toBe(closes - pausedAt);
    expect(lotMsLeft(paused, pausedAt + 1_000)).toBe(closes - pausedAt);
    expect(lotMsLeft(paused, pausedAt + 240_000)).toBe(closes - pausedAt);
    expect(closes - pausedAt).toBe(15_000);
  });

  it('counts down against the server clock when the room runs, and has no time without a deadline', () => {
    const now = Date.parse(open.current!.closesAt!) - 12_345;
    expect(lotMsLeft(open, now)).toBe(12_345);
    expect(lotMsLeft(settled, now)).toBeNull();
    expect(lotMsLeft(null, now)).toBeNull();
  });

  it('a frozen clock is never overdue, so the poller does not hammer the server for a close that cannot happen', () => {
    expect(isOverdue(paused, 0, closes + 60_000)).toBe(false);
    expect(isOverdue({ ...paused, show: { ...paused.show, pause: { ...paused.show.pause, paused: false } } }, 0, closes + 60_000)).toBe(true);
  });

  it('the deadline that moves when the pause ends is not announced as a late-bid extension', () => {
    const resumed = { ...paused, show: { ...paused.show, pause: { paused: false, pausedAt: null, resumesBy: null, used: 1, max: 2 } }, current: { ...paused.current!, closesAt: new Date(closes + 90_000).toISOString() } };
    expect(extensionSeconds(paused, resumed)).toBe(0);
    expect(extensionSeconds(open, { ...open, current: { ...open.current!, closesAt: new Date(Date.parse(open.current!.closesAt!) + 15_000).toISOString() } })).toBe(15);
  });
});
