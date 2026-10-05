import { describe, expect, it } from 'vitest';
import type { CatalogueLot, LiveSnapshot, ShowSummary } from '@/contracts/api';
import { canCancel, canEditReserve, canEnd, canExtend, canStart, canWithdraw, mergeLots, needsReadiness, pauseGate, type LotRow } from '../manageRules';
import { START_GRACE_MS, archive, isStartingNow, showTotal, upcoming } from '../scheduleRules';
import { readRecent, rememberShow } from '../recent';
import { hasSellerRole, paddleCandidates, settlementHref, sortByDue, type PendingSettlement } from '../../account/desk';
import { fixture } from './fetchStub';

const snapshot = fixture<LiveSnapshot>('live-snapshot.open');
const detail = fixture<{ lots: CatalogueLot[] }>('show-detail');

describe('manage rules (offers only what the server will accept)', () => {
  const row = (over: Partial<LotRow>): LotRow => ({
    id: 'x', lotNumber: 1, name: 'n', imageUrl: null, grade: null, reserve: null, openingPrice: '1', increment: '1', consignStatus: 'ready',
    state: 'catalogued', bidCount: 0, highBid: null, closesAt: null, ...over,
  });

  it('withdraw and extend need bid_count = 0', () => {
    expect(canWithdraw(row({ state: 'catalogued' }))).toBe(true);
    expect(canWithdraw(row({ state: 'open' }))).toBe(true);
    expect(canWithdraw(row({ state: 'open', bidCount: 1 }))).toBe(false);
    expect(canWithdraw(row({ state: 'sold' }))).toBe(false);
    expect(canWithdraw(row({ state: 'withdrawn' }))).toBe(false);
    expect(canExtend(row({ state: 'open' }))).toBe(true);
    expect(canExtend(row({ state: 'open', bidCount: 3 }))).toBe(false);
    expect(canExtend(row({ state: 'catalogued' }))).toBe(false);
  });
  it('the reserve is editable only before the lot opens', () => {
    expect(canEditReserve(row({ state: 'catalogued' }))).toBe(true);
    expect(canEditReserve(row({ state: 'open' }))).toBe(false);
  });
  it('offers the readiness re-check for a waiting lot that is not ready', () => {
    expect(needsReadiness(row({ consignStatus: 'pending' }))).toBe(true);
    expect(needsReadiness(row({ consignStatus: 'ready' }))).toBe(false);
    expect(needsReadiness(row({ consignStatus: 'pending', state: 'open' }))).toBe(false);
  });
  it('show buttons follow the show status', () => {
    expect([canStart('scheduled'), canStart('live'), canStart('ended')]).toEqual([true, false, false]);
    expect([canEnd('scheduled'), canEnd('live'), canEnd('ended')]).toEqual([false, true, false]);
    expect([canCancel('scheduled'), canCancel('live')]).toEqual([true, false]);
  });
  it('merges the snapshot over the catalogue by lot id and orders by lot number', () => {
    const rows = mergeLots(detail.lots, snapshot);
    expect(rows.map((r) => r.lotNumber)).toEqual([...rows.map((r) => r.lotNumber)].sort((a, b) => a - b));
    const live = snapshot.lots[0];
    const merged = rows.find((r) => r.id === live.id)!;
    expect(merged).toMatchObject({ state: live.state, bidCount: live.bidCount, highBid: live.highBid });
  });
  it('without a snapshot every lot is waiting with no bids', () => {
    for (const r of mergeLots(detail.lots, null)) expect(r).toMatchObject({ state: 'catalogued', bidCount: 0, highBid: null });
  });
});

describe('schedule rules (nothing invented, nothing stale)', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const show = (over: Partial<ShowSummary>): ShowSummary => ({
    id: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10', title: 't', status: 'scheduled', scheduledAt: null, startedAt: null, endedAt: null, lotCount: 3, soldCount: 0,
    hammerTotal: '0', cluster: 'devnet', isHouse: false, thumbs: [], kind: 'live', ...over,
  });

  it('drops a scheduled row whose start is long past (old seed data) and keeps one still inside the grace window', () => {
    const old = show({ id: 'a', scheduledAt: '2026-09-04T22:14:00Z' });
    const justNow = show({ id: 'b', scheduledAt: new Date(NOW - START_GRACE_MS + 1000).toISOString() });
    const future = show({ id: 'c', scheduledAt: '2026-10-06T18:00:00Z' });
    expect(upcoming([old, justNow, future], NOW).map((s) => s.id)).toEqual(['b', 'c']);
  });
  it('sorts soonest first, rows with no time last', () => {
    const a = show({ id: 'a', scheduledAt: '2026-10-07T00:00:00Z' });
    const b = show({ id: 'b', scheduledAt: '2026-10-06T00:00:00Z' });
    const c = show({ id: 'c', scheduledAt: null });
    expect(upcoming([c, a, b], NOW).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
  it('knows when the start has come', () => {
    expect(isStartingNow(show({ scheduledAt: '2026-10-05T11:59:00Z' }), NOW)).toBe(true);
    expect(isStartingNow(show({ scheduledAt: '2026-10-05T12:01:00Z' }), NOW)).toBe(false);
    expect(isStartingNow(show({ scheduledAt: null }), NOW)).toBe(false);
  });
  it('shows a hammer total only when a lot sold', () => {
    expect(showTotal(show({ soldCount: 0, hammerTotal: '1091000000' }))).toBeNull();
    expect(showTotal(show({ soldCount: 2, hammerTotal: '1091000000' }))).toBe('1091000000');
  });
  it('lists the archive newest first', () => {
    const list = [show({ id: 'a', startedAt: '2026-09-01T00:00:00Z' }), show({ id: 'b', startedAt: '2026-09-09T00:00:00Z' }), show({ id: 'c', startedAt: null })];
    expect(archive(list).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('recent shows (per-browser convenience)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const A = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
  const B = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';

  it('remembers newest first, without duplicates, at most 10', () => {
    const store = mem();
    rememberShow({ id: A, title: 'A' }, 1, store);
    rememberShow({ id: B, title: 'B' }, 2, store);
    rememberShow({ id: A, title: 'A again' }, 3, store);
    expect(readRecent(store).map((r) => r.title)).toEqual(['A again', 'B']);
    for (let i = 0; i < 15; i++) rememberShow({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title: String(i) }, 10 + i, store);
    expect(readRecent(store)).toHaveLength(10);
  });
  it('survives garbage, wrong shapes, bad ids and a missing or throwing store', () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent({ getItem: () => '{oops', setItem: () => {} })).toEqual([]);
    expect(readRecent({ getItem: () => '{"a":1}', setItem: () => {} })).toEqual([]);
    expect(readRecent({ getItem: () => JSON.stringify([{ id: 'not-a-uuid', title: 'x', at: 1 }, { id: A, title: 'ok', at: 1 }]), setItem: () => {} }).map((r) => r.title)).toEqual(['ok']);
    expect(() => rememberShow({ id: A, title: 'x' }, 1, { getItem: () => null, setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});

describe('settlement desk helpers', () => {
  const me = fixture<{ pending: PendingSettlement[] }>('me');
  const p = (over: Partial<PendingSettlement>): PendingSettlement => ({ ...me.pending[0], ...over });

  it('orders by the soonest deadline', () => {
    const list = [p({ settlementId: 'late', dueAt: '2026-10-05T19:00:00Z' }), p({ settlementId: 'soon', dueAt: '2026-10-05T18:00:00Z' })];
    expect(sortByDue(list).map((x) => x.settlementId)).toEqual(['soon', 'late']);
  });
  it('flags a seller role (the strike rule applies)', () => {
    expect(hasSellerRole([p({ role: 'buyer' })])).toBe(false);
    expect(hasSellerRole([p({ role: 'buyer' }), p({ role: 'seller' })])).toBe(true);
  });
  it('links into the room signing UI when the show is known, else to the lot audit page', () => {
    expect(settlementHref(p({ showId: 'S', settlementId: 'SET' }))).toBe('/room/S?settle=SET');
    expect(settlementHref({ ...p({ lotId: 'LOT' }), showId: undefined } as never)).toBe('/verify/LOT');
  });
  it('asks for paddles only in shows that are not over, at most 8', () => {
    const shows = Array.from({ length: 12 }, (_, i) => ({ id: String(i), status: i === 0 ? 'ended' : 'live' }) as ShowSummary);
    const c = paddleCandidates(shows);
    expect(c).toHaveLength(8);
    expect(c.every((s) => s.status !== 'ended')).toBe(true);
  });
});

describe('the pause gate (what the Rostrum offers; the server decides)', () => {
  const NOW = Date.parse('2026-10-05T18:00:00Z');
  const pause = { paused: false, pausedAt: null, resumesBy: null, used: 0, max: 2 };
  const base = { status: 'live' as const, kind: 'live' as const, pause, openLotClosesAt: new Date(NOW + 60_000).toISOString(), serverNowMs: NOW };
  it('offers the pause on a live room with a lot that has time left', () => {
    expect(pauseGate(base)).toBe('ok');
    expect(pauseGate({ ...base, openLotClosesAt: new Date(NOW + 10_000).toISOString() })).toBe('ok');
  });
  it('says why not: late, no lot, limit, already paused, and nothing at all outside a live room or on a timed one', () => {
    expect(pauseGate({ ...base, openLotClosesAt: new Date(NOW + 9_999).toISOString() })).toBe('late');
    expect(pauseGate({ ...base, openLotClosesAt: null })).toBe('no_lot');
    expect(pauseGate({ ...base, pause: { ...pause, used: 2 } })).toBe('limit');
    expect(pauseGate({ ...base, pause: { ...pause, paused: true, pausedAt: new Date(NOW).toISOString(), resumesBy: new Date(NOW + 300_000).toISOString(), used: 1 } })).toBe('paused');
    expect(pauseGate({ ...base, status: 'scheduled' })).toBe('unavailable');
    expect(pauseGate({ ...base, status: 'ended' })).toBe('unavailable');
    expect(pauseGate({ ...base, kind: 'timed' })).toBe('unavailable');
  });
});
