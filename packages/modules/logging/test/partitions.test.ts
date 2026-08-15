import { describe, expect, test } from 'bun:test';
import {
  addDays,
  isPartitionName,
  partitionDay,
  partitionName,
  partitionRange,
  partitionsToDrop,
  partitionsToEnsure,
  retentionCutoff,
  utcDayStart,
} from '../src/partitions.ts';

const AUGUST_14 = new Date('2026-08-14T13:45:12.345Z');

describe('partition naming', () => {
  test('names a partition after its UTC day, zero-padded', () => {
    expect(partitionName(AUGUST_14)).toBe('message_logs_2026_08_14');
    expect(partitionName(new Date('2026-01-05T00:00:00Z'))).toBe('message_logs_2026_01_05');
  });

  test('ignores the time of day', () => {
    expect(partitionName(new Date('2026-08-14T00:00:00Z'))).toBe(
      partitionName(new Date('2026-08-14T23:59:59.999Z')),
    );
  });

  test('round-trips through partitionDay', () => {
    const day = partitionDay(partitionName(AUGUST_14));
    expect(day?.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  test('refuses names that are not ours', () => {
    for (const name of ['cases', 'message_logs', 'message_logs_2026_08', 'message_logs_x_y_z']) {
      expect(isPartitionName(name)).toBe(false);
      expect(partitionDay(name)).toBeNull();
    }
  });

  test('refuses a name whose date does not exist', () => {
    // Date.UTC would roll 2026-02-30 into March and produce a partition that
    // claims to hold a day it does not.
    expect(partitionDay('message_logs_2026_02_30')).toBeNull();
  });
});

describe('partition ranges', () => {
  test('are half-open UTC days', () => {
    const { from, to } = partitionRange(AUGUST_14);
    expect(from.toISOString()).toBe('2026-08-14T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  test('cross a month boundary correctly', () => {
    expect(partitionRange(new Date('2026-08-31T12:00:00Z')).to.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  test('cross a leap day correctly', () => {
    expect(partitionRange(new Date('2028-02-28T12:00:00Z')).to.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

describe('utcDayStart / addDays', () => {
  test('truncate to midnight UTC', () => {
    expect(utcDayStart(AUGUST_14).toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  test('move whole days without drifting', () => {
    expect(addDays(AUGUST_14, -30).toISOString()).toBe('2026-07-15T00:00:00.000Z');
    expect(addDays(AUGUST_14, 1).toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });
});

describe('retention', () => {
  test('30 days keeps today plus the previous 29', () => {
    const cutoff = retentionCutoff(AUGUST_14, 30);
    expect(cutoff.toISOString()).toBe('2026-07-16T00:00:00.000Z');

    // 30 partitions inclusive: 2026-07-16 .. 2026-08-14.
    const kept = (AUGUST_14.getTime() - cutoff.getTime()) / 86_400_000;
    expect(Math.floor(kept) + 1).toBe(30);
  });

  test('a retention of 1 keeps only today', () => {
    expect(retentionCutoff(AUGUST_14, 1).toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });
});

describe('partitionsToDrop', () => {
  const existing = [
    'message_logs_2026_07_15', // one day past a 30-day window
    'message_logs_2026_07_16', // the oldest day still kept
    'message_logs_2026_08_14', // today
    'message_logs_2026_08_15', // tomorrow, pre-created
  ];

  test('drops only what is older than the cutoff', () => {
    expect(partitionsToDrop(existing, retentionCutoff(AUGUST_14, 30))).toEqual([
      'message_logs_2026_07_15',
    ]);
  });

  test('never drops the day on the boundary', () => {
    const dropped = partitionsToDrop(existing, retentionCutoff(AUGUST_14, 30));
    expect(dropped).not.toContain('message_logs_2026_07_16');
  });

  test('leaves tables it does not recognise alone', () => {
    // This list is handed straight to DROP TABLE. "I do not know what that is"
    // has to mean "do not touch it".
    const dropped = partitionsToDrop(
      [...existing, 'cases', 'message_logs', 'message_logs_backup'],
      retentionCutoff(AUGUST_14, 30),
    );
    expect(dropped).toEqual(['message_logs_2026_07_15']);
  });

  test('drops nothing when every partition is inside the window', () => {
    expect(partitionsToDrop(existing, retentionCutoff(AUGUST_14, 365))).toEqual([]);
  });
});

describe('partitionsToEnsure', () => {
  test('covers today and the lookahead', () => {
    expect(partitionsToEnsure(AUGUST_14, 1).map(partitionName)).toEqual([
      'message_logs_2026_08_14',
      'message_logs_2026_08_15',
    ]);
  });
});
