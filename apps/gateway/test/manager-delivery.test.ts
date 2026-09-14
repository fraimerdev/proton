import { describe, expect, test } from 'bun:test';
import { CloseCodes, WebSocketShardEvents } from '@discordjs/ws';
import type { EventBus, ProtonEvent } from '@proton/core';
import type { GatewayDispatchPayload } from 'discord-api-types/v10';
import { DEFAULT_PRESENCE } from '../src/env.ts';
import { createGatewayManager } from '../src/manager.ts';
import type { SessionInfo } from '../src/session-store.ts';

const GUILD = '900000000000000001';
const CHANNEL = '800000000000000001';

type Outcome = 'publish' | 'reject' | 'hold';

interface Held {
  event: ProtonEvent;
  resolve: () => void;
}

interface HarnessOptions {
  retryDelays?: number[];
  initial?: SessionInfo[];
  storeDelayMs?: number;
  publishTimeoutMs?: number;
  shutdownDrainMs?: number;
  onEvent?: (type: string) => void;
}

function info(sessionId: string, sequence: number, shardId = 0): SessionInfo {
  return { sessionId, sequence, shardId, shardCount: 2, resumeURL: 'wss://gateway.invalid' };
}

function messageId(sequence: number, shardId = 0): string {
  return `message.created:m${shardId}:${sequence}`;
}

function harness(options: HarnessOptions = {}) {
  const stored = new Map<number, SessionInfo>();
  for (const entry of options.initial ?? []) stored.set(entry.shardId, entry);

  const writes: { shardId: number; info: SessionInfo | null }[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const held: Held[] = [];
  const published: string[] = [];
  const exits: number[] = [];
  const attempts = new Map<string, number>();
  let outcome: (event: ProtonEvent, attempt: number) => Outcome = () => 'publish';

  const bus: EventBus = {
    publish: (event) => {
      const attempt = (attempts.get(event.id) ?? 0) + 1;
      attempts.set(event.id, attempt);
      const decided = outcome(event, attempt);
      if (decided === 'reject') return Promise.reject(new Error('XADD refused: bus unreachable'));
      if (decided === 'publish') {
        published.push(event.id);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => held.push({ event, resolve }));
    },
    subscribe: () => {
      throw new Error('the gateway only publishes');
    },
  };

  const gateway = createGatewayManager({
    token: 'not-a-real-token',
    intents: 0,
    presence: DEFAULT_PRESENCE,
    restProxyUrl: 'http://127.0.0.1:9',
    store: {
      retrieveSessionInfo: async (shardId) => stored.get(shardId) ?? null,
      updateSessionInfo: async (shardId, next) => {
        if (options.storeDelayMs) await Bun.sleep(options.storeDelayMs);
        writes.push({ shardId, info: next });
        if (next) stored.set(shardId, next);
        else stored.delete(shardId);
      },
    },
    bus,
    log: { warn: (line) => warnings.push(line), error: (line) => errors.push(line) },
    exit: (code) => exits.push(code),
    publishRetryDelaysMs: options.retryDelays ?? [0],
    ...(options.publishTimeoutMs === undefined
      ? {}
      : { publishTimeoutMs: options.publishTimeoutMs }),
    ...(options.shutdownDrainMs === undefined ? {} : { shutdownDrainMs: options.shutdownDrainMs }),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const manager = gateway.ws;

  async function dispatch(t: string, s: number, d: Record<string, unknown>, shardId = 0) {
    const session = await manager.options.retrieveSessionInfo(shardId);
    if (session && s > session.sequence) {
      await manager.options.updateSessionInfo(shardId, { ...session, sequence: s });
    }
    const payload = { op: 0, t, s, d } as unknown as GatewayDispatchPayload;
    manager.emit(WebSocketShardEvents.Dispatch, payload, shardId);
  }

  return {
    manager,
    stored,
    writes,
    warnings,
    errors,
    held,
    published,
    exits,
    shutdown: (reason = 'received SIGTERM') => gateway.shutdown(reason),
    setOutcome(next: (event: ProtonEvent, attempt: number) => Outcome) {
      outcome = next;
    },
    storedSequence: (shardId = 0) => stored.get(shardId)?.sequence,
    async ready(sessionId: string, shardId = 0) {
      await manager.options.updateSessionInfo(shardId, info(sessionId, 1, shardId));
      await dispatch('READY', 1, { session_id: sessionId }, shardId);
    },
    message: (s: number, shardId = 0) =>
      dispatch(
        'MESSAGE_CREATE',
        s,
        {
          id: `m${shardId}:${s}`,
          channel_id: CHANNEL,
          guild_id: GUILD,
          timestamp: '2026-09-13T00:00:00.000Z',
        },
        shardId,
      ),
    typing: (s: number, shardId = 0) =>
      dispatch('TYPING_START', s, { channel_id: CHANNEL, guild_id: GUILD }, shardId),
    release(id: string) {
      for (let index = held.length - 1; index >= 0; index--) {
        const entry = held[index];
        if (entry?.event.id !== id) continue;
        held.splice(index, 1);
        entry.resolve();
      }
    },
    flush: () => Bun.sleep(10),
    async until(predicate: () => boolean) {
      for (let tick = 0; tick < 300 && !predicate(); tick++) await Bun.sleep(1);
    },
  };
}

describe('the stored resume sequence only covers published dispatches', () => {
  test('a rejected publish is retried, logged, and never advances the stored sequence', async () => {
    const h = harness({ retryDelays: [0, 0] });
    await h.ready('session');
    h.setOutcome(() => 'reject');

    await h.message(2);
    await h.until(() => h.errors.length > 0);
    await h.flush();

    expect(h.storedSequence()).toBe(1);
    expect(h.writes.some((write) => write.info?.sequence === 2)).toBe(false);
    expect(h.warnings).toHaveLength(2);
    expect(h.errors).toHaveLength(1);
    for (const line of [...h.warnings, ...h.errors]) {
      expect(line).toContain('message.created');
      expect(line).toContain(messageId(2));
      expect(line).toContain('shard 0');
      expect(line).toContain('sequence 2');
    }
  });

  test('publishes that finish out of order advance it only over a contiguous run', async () => {
    const h = harness();
    await h.ready('session');
    h.setOutcome(() => 'hold');
    for (const s of [2, 3, 4, 5]) await h.message(s);

    h.release(messageId(3));
    await h.flush();
    expect(h.storedSequence()).toBe(1);

    h.release(messageId(2));
    await h.until(() => h.storedSequence() === 3);
    expect(h.storedSequence()).toBe(3);

    h.release(messageId(5));
    await h.flush();
    expect(h.storedSequence()).toBe(3);

    h.release(messageId(4));
    await h.until(() => h.storedSequence() === 5);
    expect(h.storedSequence()).toBe(5);
  });

  test('a dispatch that normalises to no events counts as published', async () => {
    const h = harness();
    await h.ready('session');

    await h.typing(2);
    await h.until(() => h.storedSequence() === 2);
    expect(h.storedSequence()).toBe(2);

    h.setOutcome(() => 'hold');
    await h.message(3);
    await h.typing(4);
    await h.flush();
    expect(h.storedSequence()).toBe(2);

    h.release(messageId(3));
    await h.until(() => h.storedSequence() === 4);
    expect(h.storedSequence()).toBe(4);
  });

  test('a publish that succeeds on retry advances the stored sequence', async () => {
    const h = harness({ retryDelays: [0] });
    await h.ready('session');
    h.setOutcome((_, attempt) => (attempt === 1 ? 'reject' : 'hold'));

    await h.message(2);
    await h.until(() => h.held.length === 1);
    expect(h.held).toHaveLength(1);
    expect(h.storedSequence()).toBe(1);
    expect(h.warnings).toHaveLength(1);

    h.release(messageId(2));
    await h.until(() => h.storedSequence() === 2);
    expect(h.storedSequence()).toBe(2);
    expect(h.errors).toEqual([]);
  });

  test('heartbeats and the dispatch gate still see the highest sequence received', async () => {
    const h = harness();
    await h.ready('session');
    h.setOutcome(() => 'hold');

    await h.message(2);

    expect((await h.manager.options.retrieveSessionInfo(0))?.sequence).toBe(2);
    expect(h.storedSequence()).toBe(1);
  });

  test('a boot that resumes a stored session holds at the stored sequence until replays publish', async () => {
    const h = harness({ initial: [info('stored', 7)] });
    expect((await h.manager.options.retrieveSessionInfo(0))?.sequence).toBe(7);
    h.setOutcome(() => 'hold');

    await h.message(8);
    await h.flush();
    expect(h.storedSequence()).toBe(7);

    h.release(messageId(8));
    await h.until(() => h.storedSequence() === 8);
    expect(h.stored.get(0)).toEqual(info('stored', 8));
  });

  test('each shard stores its own sequence', async () => {
    const h = harness();
    await h.ready('zero', 0);
    await h.ready('one', 1);
    h.setOutcome((event) => (event.id === messageId(2, 1) ? 'hold' : 'publish'));

    await h.message(2, 1);
    await h.message(2, 0);
    await h.until(() => h.storedSequence(0) === 2);

    expect(h.storedSequence(0)).toBe(2);
    expect(h.storedSequence(1)).toBe(1);
  });

  test('a slow store receives sequence writes in order and ends on the latest', async () => {
    const h = harness({ storeDelayMs: 3 });
    await h.ready('session');

    for (let s = 2; s <= 12; s++) await h.message(s);
    await h.until(() => h.storedSequence() === 12);

    const sequences = h.writes.flatMap((write) => (write.info ? [write.info.sequence] : []));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(h.storedSequence()).toBe(12);
  });

  test('a publish that never answers times out, is logged, and is retried', async () => {
    const h = harness({ retryDelays: [0], publishTimeoutMs: 20 });
    await h.ready('session');
    h.setOutcome((_, attempt) => (attempt === 1 ? 'hold' : 'publish'));

    await h.message(2);
    await h.until(() => h.storedSequence() === 2);

    expect(h.storedSequence()).toBe(2);
    expect(h.errors).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain(messageId(2));
    expect(h.warnings[0]).toContain('sequence 2');
    expect(h.warnings[0]).toContain('20ms');
  });

  test('a publish that never answers on any attempt holds the stored sequence', async () => {
    const h = harness({ retryDelays: [0], publishTimeoutMs: 10 });
    await h.ready('session');
    h.setOutcome(() => 'hold');

    await h.message(2);
    await h.until(() => h.errors.length > 0);

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain(messageId(2));
    expect(h.warnings).toHaveLength(1);
    expect(h.storedSequence()).toBe(1);
  });

  test('an onEvent hook that throws neither drops the event nor stalls the sequence', async () => {
    const h = harness({
      onEvent: () => {
        throw new Error('metrics sink closed');
      },
    });
    await h.ready('session');

    await h.message(2);
    await h.until(() => h.storedSequence() === 2);

    expect(h.published).toContain(messageId(2));
    expect(h.storedSequence()).toBe(2);
    expect(h.warnings.some((line) => line.includes('metrics sink closed'))).toBe(true);
  });
});

describe('session replacement and deletion', () => {
  test('a new session tracks afresh and a late publish from the old one writes nothing', async () => {
    const h = harness();
    await h.ready('old');
    h.setOutcome(() => 'hold');
    await h.message(2);

    await h.manager.options.updateSessionInfo(0, null);
    expect(h.stored.has(0)).toBe(false);

    h.setOutcome(() => 'publish');
    await h.ready('new');
    await h.typing(2);
    await h.until(() => h.storedSequence() === 2);
    expect(h.stored.get(0)).toEqual(info('new', 2));

    const before = h.writes.length;
    h.release(messageId(2));
    await h.flush();

    expect(h.writes.slice(before)).toEqual([]);
    expect(h.stored.get(0)).toEqual(info('new', 2));
    expect(
      h.writes.some((write) => write.info?.sessionId === 'old' && write.info.sequence > 1),
    ).toBe(false);
  });

  test('a late publish after the session is deleted writes nothing', async () => {
    const h = harness();
    await h.ready('old');
    h.setOutcome(() => 'hold');
    await h.message(2);

    await h.manager.options.updateSessionInfo(0, null);
    const before = h.writes.length;
    h.release(messageId(2));
    await h.flush();

    expect(h.writes.slice(before)).toEqual([]);
    expect(h.stored.has(0)).toBe(false);
    expect(await h.manager.options.retrieveSessionInfo(0)).toBeNull();
  });
});

describe('shutdown keeps the session for the next gateway to resume', () => {
  test('closes with the resumable close code and ignores the library deleting the session', async () => {
    const h = harness();
    await h.ready('session');
    const closes: (number | undefined)[] = [];
    h.manager.destroy = async (options) => {
      closes.push(options?.code);
      await h.manager.options.updateSessionInfo(0, null);
    };

    await h.shutdown();

    expect(closes).toEqual([CloseCodes.Resuming]);
    expect(closes[0]).not.toBe(1000);
    expect(closes[0]).not.toBe(1001);
    expect(h.stored.get(0)).toEqual(info('session', 1));
    expect(h.writes.some((write) => write.info === null)).toBe(false);
    expect(await h.manager.options.retrieveSessionInfo(0)).toEqual(info('session', 1));
  });

  test('waits for an in-flight publish that lands within the bound, and stores it', async () => {
    const h = harness({ shutdownDrainMs: 2_000, storeDelayMs: 5 });
    await h.ready('session');
    h.setOutcome(() => 'hold');
    await h.message(2);

    let finished = false;
    const stopping = h.shutdown().then(() => {
      finished = true;
    });
    await h.flush();
    expect(finished).toBe(false);

    h.release(messageId(2));
    await stopping;

    expect(h.storedSequence()).toBe(2);
    expect(h.errors).toEqual([]);
    expect(h.exits).toEqual([]);
  });

  test('gives up on a publish that outlasts the bound, logs it, and keeps the session below it', async () => {
    const h = harness({ shutdownDrainMs: 40 });
    await h.ready('session');
    h.setOutcome(() => 'hold');
    await h.message(2);

    const started = performance.now();
    await h.shutdown();
    const tookMs = performance.now() - started;

    expect(tookMs).toBeGreaterThanOrEqual(30);
    expect(tookMs).toBeLessThan(1_000);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('still unpublished after 40ms');
    expect(h.errors[0]).toContain(messageId(2));
    expect(h.errors[0]).toContain('shard 0');
    expect(h.errors[0]).toContain('sequence 2');
    expect(h.stored.get(0)).toEqual(info('session', 1));
    expect(h.exits).toEqual([]);

    h.release(messageId(2));
  });

  test('dispatches that arrive during shutdown are neither published nor tracked', async () => {
    const counted: string[] = [];
    const h = harness({ shutdownDrainMs: 2_000, onEvent: (type) => counted.push(type) });
    h.setOutcome(() => 'hold');
    await h.ready('session');
    await h.message(2);
    const countedBeforeShutdown = counted.length;

    const stopping = h.shutdown();
    h.setOutcome(() => 'publish');
    await h.message(3);
    await h.typing(4);
    h.release(messageId(2));
    await stopping;
    await h.flush();

    expect(h.published).not.toContain(messageId(3));
    expect(h.held).toEqual([]);
    expect(counted).toHaveLength(countedBeforeShutdown);
    expect(h.storedSequence()).toBe(2);
  });

  test('a second signal shares the first shutdown', async () => {
    const h = harness();
    await h.ready('session');
    let destroys = 0;
    h.manager.destroy = async () => {
      destroys++;
    };

    await Promise.all([h.shutdown('received SIGINT'), h.shutdown('received SIGTERM')]);

    expect(destroys).toBe(1);
  });
});

describe('a publish that exhausts its retries exits the process', () => {
  test('exits non-zero, keeps the stored session, and no later shutdown deletes it', async () => {
    const h = harness({ retryDelays: [0] });
    await h.ready('session');
    h.setOutcome(() => 'reject');

    await h.message(2);
    await h.until(() => h.exits.length > 0);

    expect(h.exits).toEqual([1]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain(messageId(2));
    expect(h.errors[0]).toContain('shard 0');
    expect(h.errors[0]).toContain('sequence 2');
    expect(h.stored.get(0)).toEqual(info('session', 1));

    h.manager.destroy = async () => {
      await h.manager.options.updateSessionInfo(0, null);
    };
    await h.manager.options.updateSessionInfo(0, null);
    await h.shutdown();

    expect(h.stored.get(0)).toEqual(info('session', 1));
    expect(h.writes.some((write) => write.info === null)).toBe(false);
    expect(h.exits).toEqual([1]);
  });

  test('exits once without waiting on a publish that is still stuck', async () => {
    const h = harness({ retryDelays: [0], publishTimeoutMs: 60_000 });
    await h.ready('session');
    h.setOutcome((event) => (event.id === messageId(2) ? 'hold' : 'reject'));

    await h.message(2);
    await h.message(3);
    await h.message(4);
    await h.until(() => h.errors.length >= 2);
    await h.flush();

    expect(h.exits).toEqual([1]);
    expect(h.held.map((entry) => entry.event.id)).toEqual([messageId(2)]);
    expect(h.storedSequence()).toBe(1);

    h.release(messageId(2));
  });

  test('dispatches after the exit are dropped rather than published', async () => {
    const h = harness({ retryDelays: [0] });
    await h.ready('session');
    h.setOutcome(() => 'reject');
    await h.message(2);
    await h.until(() => h.exits.length > 0);

    h.setOutcome(() => 'publish');
    await h.message(3);
    await h.flush();

    expect(h.published).toEqual([]);
    expect(h.storedSequence()).toBe(1);
  });

  test('a fresh gateway on that stored session resumes from the watermark, not the highest sequence received', async () => {
    const before = harness({ retryDelays: [0] });
    await before.ready('session');
    before.setOutcome((event) => (event.id === messageId(3) ? 'reject' : 'publish'));

    await before.message(2);
    await before.message(3);
    await before.message(4);
    await before.until(() => before.exits.length > 0);
    await before.flush();

    expect((await before.manager.options.retrieveSessionInfo(0))?.sequence).toBe(4);
    expect(before.storedSequence()).toBe(2);

    const stored = before.stored.get(0);
    if (!stored) throw new Error('the exit deleted the stored session');
    const after = harness({ initial: [stored] });

    expect(await after.manager.options.retrieveSessionInfo(0)).toEqual(info('session', 2));

    await after.message(3);
    await after.message(4);
    await after.until(() => after.storedSequence() === 4);

    expect(after.published).toEqual([messageId(3), messageId(4)]);
    expect(after.stored.get(0)).toEqual(info('session', 4));
    expect(after.exits).toEqual([]);
  });
});

describe('session writes wait only for their own store round trip', () => {
  test('a new session returns after its own write while dispatches keep settling', async () => {
    const h = harness({ storeDelayMs: 20 });
    const started = performance.now();
    let returnedAfterMs: number | undefined;
    const ready = (async () => {
      await h.manager.options.updateSessionInfo(0, info('session', 1));
      returnedAfterMs = performance.now() - started;
    })();

    let sequence = 1;
    while (performance.now() - started < 400) {
      await h.message(++sequence);
      await Bun.sleep(5);
    }
    const returnedDuringTraffic = returnedAfterMs;
    const settledDuringTraffic = h.writes.filter((write) => (write.info?.sequence ?? 0) > 1);

    await ready;

    expect(settledDuringTraffic.length).toBeGreaterThan(0);
    expect(returnedDuringTraffic).toBeDefined();
    expect(returnedDuringTraffic ?? Number.POSITIVE_INFINITY).toBeLessThan(150);
  });

  test('a session write resolves once the store holds that value or a newer one', async () => {
    const h = harness({ storeDelayMs: 10 });
    const seen: string[] = [];
    const holding = () => h.stored.get(0)?.sessionId ?? 'nothing';
    const write = async (label: string, next: SessionInfo | null) => {
      await h.manager.options.updateSessionInfo(0, next);
      seen.push(`${label} saw ${holding()}`);
    };

    await Promise.all([
      write('first', info('first', 1)),
      write('delete', null),
      write('second', info('second', 1)),
    ]);

    expect(seen).toEqual(['first saw first', 'delete saw second', 'second saw second']);
    expect(h.writes.map((entry) => entry.info?.sessionId ?? 'deleted')).toEqual([
      'first',
      'second',
    ]);
  });
});
