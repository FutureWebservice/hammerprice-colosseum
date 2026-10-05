import { describe, expect, it } from 'vitest';
import { pickHouseShow, type HouseShowRow } from '../house-room';

const d = (s: string) => new Date(s);
const row = (id: string, status: HouseShowRow['status'], o: Partial<HouseShowRow> = {}): HouseShowRow => ({ id, status, scheduledAt: null, startedAt: null, endedAt: null, ...o });

describe('pickHouseShow', () => {
  it('prefers the live show, then the soonest scheduled one, then the last ended one', () => {
    const rows = [
      row('old', 'ended', { endedAt: d('2026-09-30T00:00:00Z') }),
      row('newer-ended', 'ended', { endedAt: d('2026-10-01T00:00:00Z') }),
      row('later', 'scheduled', { scheduledAt: d('2026-10-03T00:00:00Z') }),
      row('soon', 'scheduled', { scheduledAt: d('2026-10-02T00:00:00Z') }),
    ];
    expect(pickHouseShow(rows)).toMatchObject({ id: 'soon', status: 'scheduled', startsAt: '2026-10-02T00:00:00.000Z' });
    expect(pickHouseShow([...rows, row('now', 'live', { startedAt: d('2026-10-01T10:00:00Z') })])).toMatchObject({ id: 'now', status: 'live', startsAt: null });
    expect(pickHouseShow(rows.filter((r) => r.status === 'ended'))).toMatchObject({ id: 'newer-ended', status: 'ended' });
  });
  it('is null when there is no house show', () => {
    expect(pickHouseShow([])).toBeNull();
  });
  it('a live house show beats a scheduled or ended one, however new they are', () => {
    const rows = [
      row('ended', 'ended', { endedAt: d('2026-10-04T00:00:00Z') }),
      row('next', 'scheduled', { scheduledAt: d('2026-10-04T12:00:00Z') }),
      row('live', 'live', { startedAt: d('2026-10-03T00:00:00Z') }),
    ];
    expect(pickHouseShow(rows)?.id).toBe('live');
  });
  it('no live house show: a live timed lot beats a scheduled live-room show (never the not-yet-live one)', () => {
    const rows = [row('next', 'scheduled', { scheduledAt: d('2026-10-04T12:00:00Z') }), row('timed', 'live', { kind: 'timed', startedAt: d('2026-10-04T10:00:00Z') })];
    expect(pickHouseShow(rows)).toMatchObject({ id: 'timed', status: 'live', kind: 'timed' });
  });
  it('prefer timed: a live timed lot first, else the live room; two live timed lots: the one that started last', () => {
    const rows = [
      row('room', 'live', { startedAt: d('2026-10-04T09:00:00Z') }),
      row('t1', 'live', { kind: 'timed', startedAt: d('2026-10-04T08:00:00Z') }),
      row('t2', 'live', { kind: 'timed', startedAt: d('2026-10-04T10:00:00Z') }),
    ];
    expect(pickHouseShow(rows, { prefer: 'timed' })?.id).toBe('t2');
    expect(pickHouseShow(rows)?.id).toBe('room');
    expect(pickHouseShow(rows.filter((r) => r.kind !== 'timed'), { prefer: 'timed' })?.id).toBe('room');
  });
  it('timed shows that are scheduled or ended never stand in for the house room', () => {
    expect(pickHouseShow([row('t', 'scheduled', { kind: 'timed', scheduledAt: d('2026-10-04T12:00:00Z') }), row('e', 'ended', { kind: 'timed', endedAt: d('2026-10-04T10:00:00Z') })])).toBeNull();
  });
});
