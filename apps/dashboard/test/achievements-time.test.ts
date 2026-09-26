import { describe, expect, test } from 'bun:test';
import { achievementSchema } from '@proton/module-achievements/config';
import {
  echoLine,
  formatZoned,
  isoToZoned,
  offsetLabel,
  offsetMinutes,
  timeZoneList,
  zonedToInstant,
  zoneOffsetLabel,
} from '../src/pages/achievements/time.ts';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

function utc(iso: string): number {
  return Date.parse(iso);
}

describe('a date and time in the module’s zone', () => {
  test('carries the offset of that instant, not of today', () => {
    const summer = zonedToInstant('2026-10-14', '18:00', LONDON);
    const winter = zonedToInstant('2026-12-14', '18:00', LONDON);

    expect(summer?.instant).toBe(utc('2026-10-14T17:00:00Z'));
    expect(summer?.iso).toBe('2026-10-14T18:00:00+01:00');
    expect(summer?.shift).toBe('none');
    expect(summer?.note).toBeNull();

    expect(winter?.instant).toBe(utc('2026-12-14T18:00:00Z'));
    expect(winter?.iso).toBe('2026-12-14T18:00:00+00:00');
  });

  test('west of UTC, and in a zone with a half-hour offset', () => {
    expect(zonedToInstant('2026-07-04', '09:15', NEW_YORK)?.iso).toBe('2026-07-04T09:15:00-04:00');
    expect(zonedToInstant('2026-01-04', '09:15', NEW_YORK)?.instant).toBe(
      utc('2026-01-04T14:15:00Z'),
    );
    expect(zonedToInstant('2026-06-01', '12:00', 'Asia/Kolkata')?.iso).toBe(
      '2026-06-01T12:00:00+05:30',
    );
  });

  test('is an ISO string the config schema accepts', () => {
    const iso = zonedToInstant('2026-03-08', '02:30', NEW_YORK)?.iso;

    expect(
      achievementSchema.shape.endsAt.safeParse(iso).success &&
        achievementSchema.shape.startsAt.safeParse(iso).success,
    ).toBe(true);
  });

  test('refuses dates and times that are not on the calendar', () => {
    expect(zonedToInstant('2026-02-30', '12:00', LONDON)).toBeNull();
    expect(zonedToInstant('2026-13-01', '12:00', LONDON)).toBeNull();
    expect(zonedToInstant('2026-10-14', '24:00', LONDON)).toBeNull();
    expect(zonedToInstant('2026-10-14', '18:60', LONDON)).toBeNull();
    expect(zonedToInstant('14/10/2026', '18:00', LONDON)).toBeNull();
    expect(zonedToInstant('2026-10-14', '6pm', LONDON)).toBeNull();
  });

  test('reads a stored instant back as the date and time in the zone', () => {
    expect(isoToZoned('2026-10-14T17:00:00Z', LONDON)).toEqual({
      date: '2026-10-14',
      time: '18:00',
    });
    expect(isoToZoned('2026-10-14T18:00:00+01:00', NEW_YORK)).toEqual({
      date: '2026-10-14',
      time: '13:00',
    });
    expect(isoToZoned(undefined, LONDON)).toBeNull();
    expect(isoToZoned('not a date', LONDON)).toBeNull();
  });

  test('round-trips through the zone for every hour of a year', () => {
    for (const zone of [LONDON, NEW_YORK, 'Australia/Sydney', 'UTC']) {
      for (let hour = 0; hour < 365 * 24; hour += 7) {
        const instant = utc('2026-01-01T00:00:00Z') + hour * 3_600_000;
        const parts = isoToZoned(new Date(instant).toISOString(), zone);
        const back = parts === null ? null : zonedToInstant(parts.date, parts.time, zone);

        if (back?.shift === 'repeated') {
          expect(back.instant).toBeLessThanOrEqual(instant);
        } else {
          expect(back?.instant).toBe(instant);
        }
      }
    }
  });
});

describe('clock changes', () => {
  test('London: a time the clocks skip moves to the next minute that exists, with a note', () => {
    const skipped = zonedToInstant('2026-03-29', '01:30', LONDON);

    expect(skipped?.instant).toBe(utc('2026-03-29T01:00:00Z'));
    expect(skipped?.iso).toBe('2026-03-29T02:00:00+01:00');
    expect(skipped?.time).toBe('02:00');
    expect(skipped?.shift).toBe('skipped');
    expect(skipped?.note).toBe(
      'Europe/London skips 01:30 on 29 Mar 2026 when the clocks go forward, so this is 02:00.',
    );

    expect(zonedToInstant('2026-03-29', '01:00', LONDON)?.shift).toBe('skipped');
    expect(zonedToInstant('2026-03-29', '00:59', LONDON)?.instant).toBe(
      utc('2026-03-29T00:59:00Z'),
    );
    expect(zonedToInstant('2026-03-29', '02:00', LONDON)?.shift).toBe('none');
  });

  test('London: a time that happens twice takes the earlier one', () => {
    const repeated = zonedToInstant('2026-10-25', '01:30', LONDON);

    expect(repeated?.instant).toBe(utc('2026-10-25T00:30:00Z'));
    expect(repeated?.iso).toBe('2026-10-25T01:30:00+01:00');
    expect(repeated?.shift).toBe('repeated');
    expect(repeated?.note).toBe(
      '01:30 happens twice on 25 Oct 2026 in Europe/London when the clocks go back. This is the first, at UTC+01:00.',
    );

    expect(zonedToInstant('2026-10-25', '02:00', LONDON)?.instant).toBe(
      utc('2026-10-25T02:00:00Z'),
    );
    expect(zonedToInstant('2026-10-25', '00:59', LONDON)?.shift).toBe('none');
  });

  test('New York: the spring gap and the autumn overlap', () => {
    const skipped = zonedToInstant('2026-03-08', '02:30', NEW_YORK);
    expect(skipped?.instant).toBe(utc('2026-03-08T07:00:00Z'));
    expect(skipped?.iso).toBe('2026-03-08T03:00:00-04:00');
    expect(skipped?.shift).toBe('skipped');
    expect(skipped?.note).toContain('so this is 03:00.');

    const repeated = zonedToInstant('2026-11-01', '01:30', NEW_YORK);
    expect(repeated?.instant).toBe(utc('2026-11-01T05:30:00Z'));
    expect(repeated?.iso).toBe('2026-11-01T01:30:00-04:00');
    expect(repeated?.shift).toBe('repeated');
    expect(repeated?.note).toContain('This is the first, at UTC-04:00.');
  });

  test('a skipped whole day lands on the next day and says so', () => {
    const skipped = zonedToInstant('2011-12-30', '12:00', 'Pacific/Apia');

    expect(skipped?.date).toBe('2011-12-31');
    expect(skipped?.time).toBe('00:00');
    expect(skipped?.note).toContain('so this is 31 Dec 2011, 00:00.');
  });
});

describe('offsets and the echo line', () => {
  test('offsets are read at the instant', () => {
    expect(offsetMinutes(LONDON, utc('2026-07-01T12:00:00Z'))).toBe(60);
    expect(offsetMinutes(LONDON, utc('2026-01-01T12:00:00Z'))).toBe(0);
    expect(offsetMinutes('America/St_Johns', utc('2026-01-01T12:00:00Z'))).toBe(-210);
    expect(offsetLabel(-210)).toBe('UTC-03:30');
    expect(offsetLabel(0)).toBe('UTC+00:00');
    expect(offsetLabel(330)).toBe('UTC+05:30');
    expect(zoneOffsetLabel('Not/AZone', 0)).toBeNull();
  });

  test('formats dates by hand, so no locale spells September “Sept”', () => {
    expect(formatZoned(utc('2026-09-05T08:07:00Z'), 'UTC')).toBe('5 Sep 2026, 08:07');
  });

  test('says the time in the module zone, its offset then, and the viewer’s own time', () => {
    const ends = zonedToInstant('2026-10-14', '18:00', LONDON)?.instant ?? 0;

    expect(echoLine('Ends', ends, LONDON, 'Europe/Paris')).toBe(
      'Ends 14 Oct 2026, 18:00 Europe/London (UTC+01:00), which is 19:00 your time',
    );
    expect(echoLine('Ends', ends, LONDON, 'Asia/Tokyo')).toBe(
      'Ends 14 Oct 2026, 18:00 Europe/London (UTC+01:00), which is 15 Oct 2026, 02:00 your time',
    );
  });

  test('leaves out the viewer’s time when it is the same clock', () => {
    const starts = zonedToInstant('2026-12-01', '09:00', LONDON)?.instant ?? 0;

    expect(echoLine('Starts', starts, LONDON, LONDON)).toBe(
      'Starts 1 Dec 2026, 09:00 Europe/London (UTC+00:00)',
    );
    expect(echoLine('Starts', starts, LONDON, 'UTC')).toBe(
      'Starts 1 Dec 2026, 09:00 Europe/London (UTC+00:00)',
    );
    expect(echoLine('Starts', starts, LONDON)).toBe(
      'Starts 1 Dec 2026, 09:00 Europe/London (UTC+00:00)',
    );
  });
});

describe('the time zone list', () => {
  test('always offers UTC, the default, and keeps a stored zone the engine lists differently', () => {
    const zones = timeZoneList('Europe/Kyiv');

    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Kyiv');
    expect(zones).toContain(LONDON);
    expect(new Set(zones).size).toBe(zones.length);
  });
});
