import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { type AuditEntry, auditEntrySchema } from '../../src/events/audit-log.ts';
import {
  CORRELATION_GRACE_MS,
  CORRELATION_TTL_MS,
  type PendingLog,
  RedisCorrelationStore,
} from '../../src/events/correlation.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000021';
const ACTION_CHANNEL_CREATE = 10;

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async set(key: string, value: string, _px: 'PX', ttlMs: number): Promise<'OK'> {
    this.values.set(key, value);
    this.ttls.set(key, ttlMs);
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

function build(): { redis: FakeRedis; store: RedisCorrelationStore } {
  const redis = new FakeRedis();
  return { redis, store: new RedisCorrelationStore(redis as unknown as Redis) };
}

const entry: AuditEntry = auditEntrySchema.parse({
  entryId: '1537750759112835075',
  guildId: GUILD,
  actionType: ACTION_CHANNEL_CREATE,
  actorId: '200000000000000009',
  targetId: CHANNEL,
  reason: null,
  changes: [{ key: 'name', new_value: 'announcements' }],
  options: null,
});

const pending: PendingLog = {
  logKey: 'channels.created',
  guildId: GUILD,
  entity: { id: CHANNEL, name: 'announcements' },
  occurredAt: 1_700_000_000_000,
};

describe('audit correlation', () => {
  test('the audit side round-trips with its changes intact', async () => {
    const { store } = build();
    await store.putAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL, entry);

    const taken = await store.takeAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL);

    expect(taken?.actorId).toBe('200000000000000009');
    expect(taken?.changes).toEqual([{ key: 'name', new_value: 'announcements' }]);
  });

  test('the entity side round-trips', async () => {
    const { store } = build();
    await store.putPending(GUILD, ACTION_CHANNEL_CREATE, CHANNEL, pending);

    expect(await store.takePending(GUILD, ACTION_CHANNEL_CREATE, CHANNEL)).toEqual(pending);
  });

  test('taking is exclusive, so only one side can render the log', async () => {
    const { store } = build();
    await store.putAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL, entry);

    expect(await store.takeAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL)).not.toBeNull();
    expect(await store.takeAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL)).toBeNull();
  });

  test('a missing counterpart reads as null rather than throwing', async () => {
    const { store } = build();

    expect(await store.takeAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL)).toBeNull();
    expect(await store.takePending(GUILD, ACTION_CHANNEL_CREATE, CHANNEL)).toBeNull();
  });

  test('the two sides use separate keys, so neither consumes the other', async () => {
    const { redis, store } = build();
    await store.putAudit(GUILD, ACTION_CHANNEL_CREATE, CHANNEL, entry);
    await store.putPending(GUILD, ACTION_CHANNEL_CREATE, CHANNEL, pending);

    expect(redis.values.size).toBe(2);
    expect([...redis.values.keys()].sort()).toEqual([
      `proton:correlate:audit:${GUILD}:10:${CHANNEL}`,
      `proton:correlate:entity:${GUILD}:10:${CHANNEL}`,
    ]);
  });

  test('different actions on the same target do not collide', async () => {
    const { store } = build();
    await store.putAudit(GUILD, 10, CHANNEL, entry);

    expect(await store.takeAudit(GUILD, 12, CHANNEL)).toBeNull();
    expect(await store.takeAudit(GUILD, 10, CHANNEL)).not.toBeNull();
  });

  test('the same action in another guild does not collide', async () => {
    const { store } = build();
    await store.putAudit(GUILD, 10, CHANNEL, entry);

    expect(await store.takeAudit('900000000000000002', 10, CHANNEL)).toBeNull();
  });

  test('rows expire, so a counterpart that never arrives cannot leak', async () => {
    const { redis, store } = build();
    await store.putAudit(GUILD, 10, CHANNEL, entry);
    await store.putPending(GUILD, 10, CHANNEL, pending);

    expect([...redis.ttls.values()]).toEqual([CORRELATION_TTL_MS, CORRELATION_TTL_MS]);
  });

  test('the flush grace is shorter than the row lifetime, or a flush would find nothing', () => {
    expect(CORRELATION_GRACE_MS).toBeLessThan(CORRELATION_TTL_MS);
  });

  test('an unreadable row reads as null rather than crashing the handler', async () => {
    const { redis, store } = build();
    redis.values.set(`proton:correlate:audit:${GUILD}:10:${CHANNEL}`, 'not json');
    redis.values.set(`proton:correlate:entity:${GUILD}:10:${CHANNEL}`, '{"nope":true}');

    expect(await store.takeAudit(GUILD, 10, CHANNEL)).toBeNull();
    expect(await store.takePending(GUILD, 10, CHANNEL)).toBeNull();
  });
});
