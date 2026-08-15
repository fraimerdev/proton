import { describe, expect, test } from 'bun:test';
import { maintenancePayloadSchema, runMessageLogMaintenance } from '../src/maintenance.ts';
import type { MessageLogStore } from '../src/store.ts';
import { MemoryMessageLogStore } from './harness.ts';

const NOW = new Date('2026-08-14T00:10:00Z');

/** A store already holding 35 days of partitions, ending today. */
function stocked(): MemoryMessageLogStore {
  const store = new MemoryMessageLogStore();
  for (let offset = 34; offset >= 0; offset--) {
    store.partitions.add(
      `message_logs_${new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '_')}`,
    );
  }
  return store;
}

describe('partition maintenance', () => {
  test('creates today and tomorrow, so a write at midnight has somewhere to land', async () => {
    const store = new MemoryMessageLogStore();

    const result = await runMessageLogMaintenance(store, { now: NOW });

    expect(result.ensured).toEqual(['message_logs_2026_08_14', 'message_logs_2026_08_15']);
    expect(await store.listPartitions()).toEqual([
      'message_logs_2026_08_14',
      'message_logs_2026_08_15',
    ]);
  });

  test('drops what is past retention and keeps the rest', async () => {
    const store = stocked();

    const result = await runMessageLogMaintenance(store, { now: NOW, retentionDays: 30 });

    // 35 days existed; the five oldest go, the 30-day window stays.
    expect(result.dropped).toEqual([
      'message_logs_2026_07_11',
      'message_logs_2026_07_12',
      'message_logs_2026_07_13',
      'message_logs_2026_07_14',
      'message_logs_2026_07_15',
    ]);

    const kept = await store.listPartitions();
    expect(kept).toContain('message_logs_2026_07_16');
    expect(kept).toContain('message_logs_2026_08_14');
    expect(kept).not.toContain('message_logs_2026_07_15');
    // 30 days kept, plus tomorrow's, which the same run created.
    expect(kept).toHaveLength(31);
  });

  test('creates before it drops, so a half-finished run errs towards too much', async () => {
    const inner = stocked();
    const order: string[] = [];

    // Surplus partitions cost disk; missing ones lose writes. If a run dies half
    // way it must be on the safe side of that trade.
    const observed: MessageLogStore = {
      append: (entries) => inner.append(entries),
      ensurePartition: (day) => {
        order.push('ensure');
        return inner.ensurePartition(day);
      },
      listPartitions: () => inner.listPartitions(),
      dropPartitions: (names) => {
        order.push('drop');
        return inner.dropPartitions(names);
      },
    };

    await runMessageLogMaintenance(observed, { now: NOW, retentionDays: 30 });

    expect(order[0]).toBe('ensure');
    expect(order.at(-1)).toBe('drop');
  });

  test('refuses a retention that would drop the day being written to', async () => {
    const store = stocked();

    await expect(runMessageLogMaintenance(store, { now: NOW, retentionDays: 0 })).rejects.toThrow();
    expect(store.dropped).toEqual([]);
  });

  test('the job payload defaults to the owner-recorded 30 days', () => {
    expect(maintenancePayloadSchema.parse({})).toEqual({ retentionDays: 30, lookaheadDays: 1 });
  });

  test('the job payload is validated on read, because it comes back out of JSONB (I5)', () => {
    expect(maintenancePayloadSchema.safeParse({ retentionDays: -1 }).success).toBe(false);
    expect(maintenancePayloadSchema.safeParse({ retentionDays: 1.5 }).success).toBe(false);
  });
});
