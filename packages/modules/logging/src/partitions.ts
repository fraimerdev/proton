export const PARTITION_PREFIX = 'message_logs_';

const PARTITION_NAME = /^message_logs_\d{4}_\d{2}_\d{2}$/;

const MS_PER_DAY = 86_400_000;

export function isPartitionName(name: string): boolean {
  return PARTITION_NAME.test(name);
}

export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function addDays(day: Date, days: number): Date {
  return new Date(utcDayStart(day).getTime() + days * MS_PER_DAY);
}

export function partitionName(day: Date): string {
  const start = utcDayStart(day);
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const date = String(start.getUTCDate()).padStart(2, '0');
  return `${PARTITION_PREFIX}${start.getUTCFullYear()}_${month}_${date}`;
}

export function partitionDay(name: string): Date | null {
  if (!isPartitionName(name)) return null;

  const [year, month, date] = name.slice(PARTITION_PREFIX.length).split('_').map(Number);
  if (year === undefined || month === undefined || date === undefined) return null;

  const day = new Date(Date.UTC(year, month - 1, date));

  return partitionName(day) === name ? day : null;
}

export function partitionRange(day: Date): { from: Date; to: Date } {
  const from = utcDayStart(day);
  return { from, to: addDays(from, 1) };
}

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return addDays(now, -(retentionDays - 1));
}

export function partitionsToDrop(existing: readonly string[], cutoff: Date): string[] {
  const boundary = utcDayStart(cutoff).getTime();

  return existing
    .filter((name) => {
      const day = partitionDay(name);
      return day !== null && day.getTime() < boundary;
    })
    .sort();
}

export function partitionsToEnsure(now: Date, lookaheadDays: number): Date[] {
  const days: Date[] = [];
  for (let offset = 0; offset <= lookaheadDays; offset++) days.push(addDays(now, offset));
  return days;
}
