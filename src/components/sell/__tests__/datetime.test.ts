import { describe, it, expect, afterEach } from 'vitest';
import {
  buildIcs, checkStart, countdown, defaultStartLocal, formatWait, formatWhen, icsHref, isoToLocalInput, localInputToIso, MIN_LEAD_MS,
} from '../datetime';

const realTz = process.env.TZ;
/** Run `fn` with the process time zone set (Node re-reads TZ on assignment). */
function inTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  }
}
afterEach(() => {
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

describe('localInputToIso: the seller types local time, the API gets UTC', () => {
  it('converts in Berlin (CEST, UTC+2, in October)', () => {
    inTz('Europe/Berlin', () => expect(localInputToIso('2026-10-06T20:00')).toBe('2026-10-06T18:00:00.000Z'));
  });
  it('converts in Berlin in winter (CET, UTC+1)', () => {
    inTz('Europe/Berlin', () => expect(localInputToIso('2026-12-24T20:00')).toBe('2026-12-24T19:00:00.000Z'));
  });
  it('converts in Los Angeles (PDT, UTC-7) across midnight UTC', () => {
    inTz('America/Los_Angeles', () => expect(localInputToIso('2026-10-06T20:00')).toBe('2026-10-07T03:00:00.000Z'));
  });
  it('is the identity in UTC', () => {
    inTz('UTC', () => expect(localInputToIso('2026-10-06T20:00')).toBe('2026-10-06T20:00:00.000Z'));
  });
  it('handles the day the clocks go back (Berlin, 2026-10-25)', () => {
    inTz('Europe/Berlin', () => {
      expect(localInputToIso('2026-10-25T01:30')).toBe('2026-10-24T23:30:00.000Z'); // still CEST
      expect(localInputToIso('2026-10-25T04:00')).toBe('2026-10-25T03:00:00.000Z'); // CET again
    });
  });
  it('moves a time that does not exist (spring forward) to a real instant instead of failing', () => {
    inTz('Europe/Berlin', () => {
      const iso = localInputToIso('2026-03-29T02:30');
      expect(iso).not.toBeNull();
      expect(new Date(iso!).getUTCHours()).toBe(1); // 03:30 CEST is 01:30Z
    });
  });
  it.each(['', '2026-10-06', '2026-10-06 20:00', '2026-13-01T10:00', '2026-02-31T10:00', 'tomorrow'])('refuses %j', (v) => {
    expect(localInputToIso(v)).toBeNull();
  });
});

describe('isoToLocalInput', () => {
  it('is the inverse of localInputToIso in every zone', () => {
    for (const tz of ['Europe/Berlin', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      inTz(tz, () => {
        for (const v of ['2026-10-06T20:00', '2026-01-01T00:00', '2026-12-31T23:45']) {
          expect(isoToLocalInput(localInputToIso(v)!)).toBe(v);
        }
      });
    }
  });
});

describe('defaultStartLocal and checkStart', () => {
  it('suggests one hour ahead, rounded up to a quarter hour', () => {
    inTz('Europe/Berlin', () => {
      expect(defaultStartLocal(new Date('2026-10-06T16:07:30Z'))).toBe('2026-10-06T19:15'); // 18:07 local, plus one hour, rounded up to 19:15
    });
  });
  it('rolls the hour over when rounding up past :45', () => {
    inTz('UTC', () => {
      expect(defaultStartLocal(new Date('2026-10-06T10:50:00Z'))).toBe('2026-10-06T12:00');
      expect(defaultStartLocal(new Date('2026-10-06T10:45:00Z'))).toBe('2026-10-06T11:45');
      expect(defaultStartLocal(new Date('2026-10-06T23:50:00Z'))).toBe('2026-10-07T01:00');
    });
  });
  it('accepts empty, flags garbage, and demands a lead time', () => {
    inTz('UTC', () => {
      const now = new Date('2026-10-06T10:00:00Z');
      expect(checkStart('', now)).toBeNull();
      expect(checkStart('nope', now)).toBe('invalid');
      expect(checkStart('2026-10-06T10:04', now)).toBe('too_soon');
      expect(checkStart('2026-10-06T09:00', now)).toBe('too_soon');
      expect(checkStart('2026-10-06T10:05', now)).toBeNull();
      expect(MIN_LEAD_MS).toBe(5 * 60_000);
    });
  });
});

describe('display', () => {
  it('shows the instant in the viewer zone and names the zone', () => {
    inTz('Europe/Berlin', () => expect(formatWhen('2026-10-06T18:00:00.000Z', 'en')).toMatch(/20:00.*(CEST|GMT\+2)/));
    inTz('America/Los_Angeles', () => expect(formatWhen('2026-10-06T18:00:00.000Z', 'en')).toMatch(/11:00.*(PDT|GMT-7)/));
  });
  it('words a wait in the viewer language', () => {
    expect(formatWait(30, 'en')).toBe('30 seconds');
    expect(formatWait(61, 'en')).toBe('2 minutes');
    expect(formatWait(3 * 3600, 'en')).toBe('3 hours');
    expect(formatWait(3 * 3600, 'de')).toBe('3 Stunden');
    expect(formatWait(0, 'en')).toBe('1 second');
  });
  it('counts down and stops at zero', () => {
    const t = Date.parse('2026-10-06T10:00:00Z');
    expect(countdown('2026-10-06T10:00:45Z', t)).toBe('00:45');
    expect(countdown('2026-10-06T11:02:03Z', t)).toBe('01:02:03');
    expect(countdown('2026-10-08T13:04:05Z', t)).toBe('2d 03:04:05');
    expect(countdown('2026-10-06T10:00:00Z', t)).toBeNull();
    expect(countdown('2026-10-06T09:59:00Z', t)).toBeNull();
  });
});

describe('calendar file', () => {
  const ics = buildIcs({ id: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10', title: 'Night, slabs; "live"', startIso: '2026-10-06T18:00:00.000Z', url: 'https://x.test/en/room/3f6c', now: new Date('2026-10-01T09:00:00Z') });
  it('is a valid one-event calendar in UTC with CRLF line ends', () => {
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('DTSTART:20261006T180000Z');
    expect(ics).toContain('DTEND:20261006T190000Z');
    expect(ics).toContain('DTSTAMP:20261001T090000Z');
    expect(ics).toContain('UID:3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10@hammerprice');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
  it('escapes commas and semicolons in the title', () => {
    expect(ics).toContain('SUMMARY:Night\\, slabs\; "live"');
  });
  it('becomes a data link', () => {
    expect(icsHref(ics)).toMatch(/^data:text\/calendar;charset=utf-8,BEGIN%3AVCALENDAR/);
  });
});
