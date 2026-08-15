/**
 * Daily partition arithmetic for `message_logs`.
 *
 * Pure functions with no database in sight, because this is where the retention
 * policy actually lives: an off-by-one here either keeps message content a day
 * longer than the guild was promised or destroys a day of evidence early. Both
 * are worth exhaustive unit tests, and neither needs Postgres to find.
 */

/** Partitions are named after the UTC day they hold: `message_logs_2026_08_14`. */
export const PARTITION_PREFIX = 'message_logs_';

/**
 * Names we are willing to interpolate into DDL.
 *
 * Partition names are generated from a `Date`, never from user input, so this is
 * belt-and-braces — but `CREATE TABLE`/`DROP TABLE` cannot take an identifier as
 * a bind parameter, so the one place that builds SQL by hand gets a hard gate
 * rather than a comment promising the caller was careful.
 */
const PARTITION_NAME = /^message_logs_\d{4}_\d{2}_\d{2}$/;

const MS_PER_DAY = 86_400_000;

export function isPartitionName(name: string): boolean {
  return PARTITION_NAME.test(name);
}

/** Midnight UTC on the day `at` falls in. */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Days are added in UTC milliseconds rather than by bumping the date component,
 * so daylight-saving transitions in the host's local zone cannot shift a
 * partition boundary.
 */
export function addDays(day: Date, days: number): Date {
  return new Date(utcDayStart(day).getTime() + days * MS_PER_DAY);
}

export function partitionName(day: Date): string {
  const start = utcDayStart(day);
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const date = String(start.getUTCDate()).padStart(2, '0');
  return `${PARTITION_PREFIX}${start.getUTCFullYear()}_${month}_${date}`;
}

/** The UTC day a partition holds, or null if the name is not one of ours. */
export function partitionDay(name: string): Date | null {
  if (!isPartitionName(name)) return null;

  const [year, month, date] = name.slice(PARTITION_PREFIX.length).split('_').map(Number);
  if (year === undefined || month === undefined || date === undefined) return null;

  const day = new Date(Date.UTC(year, month - 1, date));
  // Rejects 2026_02_30, which Date.UTC would silently roll into March: a name
  // that does not round-trip is not a partition this module created.
  return partitionName(day) === name ? day : null;
}

/** Half-open range `[from, to)` — Postgres partition bounds are exclusive at the top. */
export function partitionRange(day: Date): { from: Date; to: Date } {
  const from = utcDayStart(day);
  return { from, to: addDays(from, 1) };
}

/**
 * The oldest day still kept.
 *
 * `retentionDays` counts days of data including today, so 30 keeps today plus
 * the previous 29. The stricter reading of "30 days" — a message stops being
 * retrievable on its 30th day rather than its 31st — because the looser one is
 * the sort of thing that has to be defended to a regulator, not to a reviewer.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return addDays(now, -(retentionDays - 1));
}

/**
 * Which existing partitions hold days older than the cutoff.
 *
 * Unrecognised names are left alone. This function's output is fed straight to
 * `DROP TABLE`, so "I do not know what that is" must mean "do not touch it"
 * rather than "it does not look current".
 */
export function partitionsToDrop(existing: readonly string[], cutoff: Date): string[] {
  const boundary = utcDayStart(cutoff).getTime();

  return existing
    .filter((name) => {
      const day = partitionDay(name);
      return day !== null && day.getTime() < boundary;
    })
    .sort();
}

/** Today plus `lookaheadDays` — the partitions that must exist for writes to land. */
export function partitionsToEnsure(now: Date, lookaheadDays: number): Date[] {
  const days: Date[] = [];
  for (let offset = 0; offset <= lookaheadDays; offset++) days.push(addDays(now, offset));
  return days;
}
