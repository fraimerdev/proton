import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { type ReportActionOutcome, reportActionOutcomeSchema } from '../src/events/moderation.ts';
import { REPORT_ACTION_MAILBOX_PREFIX, RedisMailbox } from '../src/mailbox.ts';
import type { SimulationOutcome } from '../src/simulation/io.ts';
import {
  RedisSimulationResults,
  SIMULATION_RESULT_PREFIX,
  SIMULATION_RESULT_TTL_MS,
} from '../src/simulation/transport.ts';

class FakeStore {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  readonly ttls = new Map<string, number>();
  readonly log: string[] = [];
  readonly blpops: Array<{ key: string; seconds: number }> = [];
  readonly waiters = new Map<string, Array<(value: string) => void>>();
  duplicates = 0;
  quits = 0;
  failQuit = false;
  msPerSecond = 5;

  push(key: string, value: string): void {
    const waiter = this.waiters.get(key)?.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }
    this.lists.set(key, [...(this.lists.get(key) ?? []), value]);
  }
}

class FakeRedis {
  constructor(readonly store: FakeStore) {}

  async get(key: string): Promise<string | null> {
    return this.store.values.get(key) ?? null;
  }

  async set(key: string, value: string, _px: 'PX', ttlMs: number): Promise<'OK'> {
    this.store.log.push(`set ${key}`);
    this.store.values.set(key, value);
    this.store.ttls.set(key, ttlMs);
    return 'OK';
  }

  multi(): FakeMulti {
    return new FakeMulti(this.store);
  }

  duplicate(): FakeRedis {
    this.store.duplicates += 1;
    return new FakeRedis(this.store);
  }

  async quit(): Promise<'OK'> {
    this.store.quits += 1;
    if (this.store.failQuit) throw new Error('connection already closed');
    return 'OK';
  }

  blpop(key: string, seconds: number): Promise<[string, string] | null> {
    this.store.blpops.push({ key, seconds });

    const queued = this.store.lists.get(key) ?? [];
    const head = queued.shift();
    if (head !== undefined) return Promise.resolve([key, head]);

    return new Promise((resolve) => {
      const waiters = this.store.waiters.get(key) ?? [];
      const waiter = (value: string) => {
        clearTimeout(timer);
        resolve([key, value]);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(null);
      }, seconds * this.store.msPerSecond);
      waiters.push(waiter);
      this.store.waiters.set(key, waiters);
    });
  }
}

class FakeMulti {
  readonly #ops: Array<() => void> = [];

  constructor(readonly store: FakeStore) {}

  rpush(key: string, value: string): FakeMulti {
    this.#ops.push(() => {
      this.store.log.push(`rpush ${key}`);
      this.store.push(key, value);
    });
    return this;
  }

  pexpire(key: string, ttlMs: number): FakeMulti {
    this.#ops.push(() => {
      this.store.log.push(`pexpire ${key}`);
      this.store.ttls.set(key, ttlMs);
    });
    return this;
  }

  async exec(): Promise<Array<[null, unknown]>> {
    for (const op of this.#ops) op();
    return this.#ops.map(() => [null, 1]);
  }
}

const GUILD = '900000000000000001';
const ID = `${GUILD}:r_01J8Z0000000000000000000`;

const outcome: ReportActionOutcome = { ok: true, code: 'claimed', message: 'Claimed.' };

function build(ttlMs?: number): { store: FakeStore; mailbox: RedisMailbox<ReportActionOutcome> } {
  const store = new FakeStore();
  const mailbox = new RedisMailbox(new FakeRedis(store) as unknown as Redis, {
    prefix: REPORT_ACTION_MAILBOX_PREFIX,
    schema: reportActionOutcomeSchema,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  return { store, mailbox };
}

describe('RedisMailbox', () => {
  test('keeps the answer and queues it under the prefix, kept copy first', async () => {
    const { store, mailbox } = build();
    await mailbox.answer(ID, outcome);

    const kept = `proton:moderation:report-action:done:${ID}`;
    const queue = `proton:moderation:report-action:mailbox:${ID}`;
    expect(store.log).toEqual([`set ${kept}`, `rpush ${queue}`, `pexpire ${queue}`]);
    expect(JSON.parse(store.values.get(kept) ?? 'null')).toEqual(outcome);
    expect(store.lists.get(queue)).toEqual([JSON.stringify(outcome)]);
    expect(store.ttls.get(kept)).toBe(120_000);
    expect(store.ttls.get(queue)).toBe(120_000);
  });

  test('honours a custom lifetime on both keys', async () => {
    const { store, mailbox } = build(30_000);
    await mailbox.answer(ID, outcome);

    expect([...store.ttls.values()]).toEqual([30_000, 30_000]);
  });

  test('recalls nothing before an answer and the answer after it', async () => {
    const { mailbox } = build();
    expect(await mailbox.recall(ID)).toBeNull();

    await mailbox.answer(ID, outcome);
    expect(await mailbox.recall(ID)).toEqual(outcome);
    expect(await mailbox.recall(`${GUILD}:someone-else`)).toBeNull();
  });

  test('an answer already given is returned without opening a blocking connection', async () => {
    const { store, mailbox } = build();
    await mailbox.answer(ID, outcome);

    expect(await mailbox.wait(ID, 20_000)).toEqual(outcome);
    expect(store.duplicates).toBe(0);
    expect(store.blpops).toEqual([]);
  });

  test('a waiter wakes on an answer that arrives later, on its own connection', async () => {
    const { store, mailbox } = build();
    const waiting = mailbox.wait(ID, 20_000);

    await Bun.sleep(1);
    await mailbox.answer(ID, outcome);

    expect(await waiting).toEqual(outcome);
    expect(store.duplicates).toBe(1);
    expect(store.quits).toBe(1);
    expect(store.blpops).toEqual([
      { key: `proton:moderation:report-action:mailbox:${ID}`, seconds: 20 },
    ]);
  });

  test('a second wait after the queue was consumed gets the kept copy', async () => {
    const { mailbox } = build();
    const first = mailbox.wait(ID, 20_000);
    await Bun.sleep(1);
    await mailbox.answer(ID, outcome);
    await first;

    expect(await mailbox.wait(ID, 20_000)).toEqual(outcome);
  });

  test('times out to null in whole seconds, never less than one, and closes its connection', async () => {
    const { store, mailbox } = build();

    expect(await mailbox.wait(ID, 250)).toBeNull();
    expect(await mailbox.wait(ID, 1_500)).toBeNull();
    expect(store.blpops.map((call) => call.seconds)).toEqual([1, 2]);
    expect(store.quits).toBe(2);
  });

  test('a failing quit does not turn an answer into an error', async () => {
    const { store, mailbox } = build();
    store.failQuit = true;
    const waiting = mailbox.wait(ID, 20_000);
    await Bun.sleep(1);
    await mailbox.answer(ID, outcome);

    expect(await waiting).toEqual(outcome);
  });

  test('a stored value that is not JSON or not the schema reads as no answer', async () => {
    const { store, mailbox } = build();
    const kept = `proton:moderation:report-action:done:${ID}`;

    store.values.set(kept, '{not json');
    expect(await mailbox.recall(ID)).toBeNull();

    store.values.set(kept, JSON.stringify({ ok: 'yes' }));
    expect(await mailbox.recall(ID)).toBeNull();
  });

  test('parses through the schema, so defaults apply on the way out', async () => {
    const store = new FakeStore();
    const mailbox = new RedisMailbox(new FakeRedis(store) as unknown as Redis, {
      prefix: 'proton:test',
      schema: z.object({ n: z.number(), tag: z.string().default('none') }),
    });
    store.values.set('proton:test:done:a', JSON.stringify({ n: 1 }));

    expect(await mailbox.recall('a')).toEqual({ n: 1, tag: 'none' });
  });

  test('ids from different guilds never share a box', async () => {
    const { mailbox } = build();
    await mailbox.answer(`${GUILD}:same-request`, outcome);

    expect(await mailbox.recall('900000000000000002:same-request')).toBeNull();
  });
});

describe('RedisSimulationResults on the mailbox', () => {
  const preview: SimulationOutcome = {
    ok: true,
    mode: 'preview',
    simulationId: 'welcome.greeting',
    usedDraft: false,
    destination: { kind: 'channel', channelId: '500000000000000021', label: '#general' },
    render: null,
    sent: null,
    error: null,
  };

  test('keeps the keys and lifetime a worker on the previous build still answers on', async () => {
    const store = new FakeStore();
    const results = new RedisSimulationResults(new FakeRedis(store) as unknown as Redis);
    await results.answer('req-12345678', preview);

    expect(store.log).toEqual([
      `set ${SIMULATION_RESULT_PREFIX}:done:req-12345678`,
      `rpush ${SIMULATION_RESULT_PREFIX}:mailbox:req-12345678`,
      `pexpire ${SIMULATION_RESULT_PREFIX}:mailbox:req-12345678`,
    ]);
    expect([...store.ttls.values()]).toEqual([SIMULATION_RESULT_TTL_MS, SIMULATION_RESULT_TTL_MS]);
    expect(await results.recall('req-12345678')).toEqual(preview);
  });

  test('waits, recalls and honours a custom prefix', async () => {
    const store = new FakeStore();
    const results = new RedisSimulationResults(new FakeRedis(store) as unknown as Redis, 'p');
    const waiting = results.wait('req-12345678', 20_000);
    await Bun.sleep(1);
    await results.answer('req-12345678', preview);

    expect(await waiting).toEqual(preview);
    expect(store.blpops).toEqual([{ key: 'p:mailbox:req-12345678', seconds: 20 }]);
    expect(await results.wait('req-12345678', 20_000)).toEqual(preview);
    expect(await results.wait('req-00000000', 100)).toBeNull();
  });
});
