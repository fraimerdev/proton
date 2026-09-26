const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_INPUT = /^(\d{2}):(\d{2})$/;

export interface ZonedParts {
  date: string;
  time: string;
}

export type ZonedShift = 'none' | 'skipped' | 'repeated';

export interface ZonedInstant extends ZonedParts {
  instant: number;
  iso: string;
  offset: number;
  shift: ZonedShift;
  note: string | null;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const held = formatters.get(timeZone);
  if (held) return held;

  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(timeZone, made);
  return made;
}

function wallClock(instant: number, timeZone: string): Wall {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

function wallMs(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function offsetMinutes(timeZone: string, instant: number): number {
  return Math.round((wallMs(instant, timeZone) - Math.floor(instant / 1000) * 1000) / MINUTE_MS);
}

export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const size = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
}

export function zoneOffsetLabel(timeZone: string, instant: number): string | null {
  try {
    return offsetLabel(offsetMinutes(timeZone, instant));
  } catch {
    return null;
  }
}

function isoOffset(minutes: number): string {
  return offsetLabel(minutes).slice(3);
}

export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const wall = wallClock(instant, timeZone);

  return {
    date: `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`,
    time: `${pad(wall.hour)}:${pad(wall.minute)}`,
  };
}

export function isoToZoned(iso: string | undefined, timeZone: string): ZonedParts | null {
  if (iso === undefined) return null;

  const instant = Date.parse(iso);
  return Number.isNaN(instant) ? null : zonedParts(instant, timeZone);
}

function localMs(date: string, time: string): number | null {
  const day = DATE_INPUT.exec(date);
  const clock = TIME_INPUT.exec(time);
  if (!day || !clock) return null;

  const [year, month, dayOfMonth, hour, minute] = [day[1], day[2], day[3], clock[1], clock[2]].map(
    Number,
  ) as [number, number, number, number, number];

  if (hour > 23 || minute > 59) return null;

  const ms = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const back = new Date(ms);

  const exists =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === dayOfMonth;

  return exists ? ms : null;
}

export function formatDay(date: string): string {
  const match = DATE_INPUT.exec(date);
  if (!match) return date;

  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

export function formatZoned(instant: number, timeZone: string): string {
  const { date, time } = zonedParts(instant, timeZone);
  return `${formatDay(date)}, ${time}`;
}

function describeShift(
  shift: ZonedShift,
  asked: ZonedParts,
  landed: ZonedParts,
  offset: number,
  timeZone: string,
): string | null {
  if (shift === 'skipped') {
    const where =
      landed.date === asked.date ? landed.time : `${formatDay(landed.date)}, ${landed.time}`;
    return (
      `${timeZone} skips ${asked.time} on ${formatDay(asked.date)} when the clocks go forward, ` +
      `so this is ${where}.`
    );
  }

  if (shift === 'repeated') {
    return (
      `${asked.time} happens twice on ${formatDay(asked.date)} in ${timeZone} when the clocks go ` +
      `back. This is the first, at ${offsetLabel(offset)}.`
    );
  }

  return null;
}

function resolved(
  instant: number,
  timeZone: string,
  shift: ZonedShift,
  asked: ZonedParts,
): ZonedInstant {
  const landed = zonedParts(instant, timeZone);
  const offset = offsetMinutes(timeZone, instant);

  return {
    ...landed,
    instant,
    iso: `${landed.date}T${landed.time}:00${isoOffset(offset)}`,
    offset,
    shift,
    note: describeShift(shift, asked, landed, offset, timeZone),
  };
}

// The offset is read at the instant itself, never today's: a deadline across a clock change has another.
export function zonedToInstant(date: string, time: string, timeZone: string): ZonedInstant | null {
  const local = localMs(date, time);
  if (local === null) return null;

  const asked = { date, time };
  const around = [local - DAY_MS, local, local + DAY_MS].map((at) => offsetMinutes(timeZone, at));

  const valid = [...new Set(around)]
    .map((offset) => local - offset * MINUTE_MS)
    .filter((candidate) => wallMs(candidate, timeZone) === local)
    .sort((a, b) => a - b);

  const first = valid[0];
  if (first !== undefined) {
    return resolved(first, timeZone, valid.length > 1 ? 'repeated' : 'none', asked);
  }

  let low = Math.floor((local - Math.max(...around) * MINUTE_MS) / MINUTE_MS);
  let high = Math.ceil((local - Math.min(...around) * MINUTE_MS) / MINUTE_MS);

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (wallMs(middle * MINUTE_MS, timeZone) > local) high = middle;
    else low = middle + 1;
  }

  return resolved(low * MINUTE_MS, timeZone, 'skipped', asked);
}

export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function echoLine(
  verb: string,
  instant: number,
  timeZone: string,
  viewerZone?: string | undefined,
): string {
  const offset = offsetMinutes(timeZone, instant);
  const line = `${verb} ${formatZoned(instant, timeZone)} ${timeZone} (${offsetLabel(offset)})`;

  if (viewerZone === undefined || offsetMinutes(viewerZone, instant) === offset) return line;

  const theirs = zonedParts(instant, timeZone);
  const yours = zonedParts(instant, viewerZone);
  const shown = yours.date === theirs.date ? yours.time : formatZoned(instant, viewerZone);

  return `${line}, which is ${shown} your time`;
}

export function timeZoneList(current?: string): string[] {
  let zones: string[] = [];

  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }

  const listed = new Set(zones);
  const extra = ['UTC', ...(current === undefined ? [] : [current])].filter(
    (zone) => !listed.has(zone),
  );

  return [...new Set(extra), ...zones];
}
