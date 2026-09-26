import { describe, expect, test } from 'bun:test';
import { type EventBus, joinrolesSyncRequestedSchema, type ProtonEvent } from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import { type JoinrolesConfig, joinrolesDefaultConfig } from '@proton/module-joinroles/config';
import type { JoinRolesRunStore, SyncFinish } from '@proton/module-joinroles/sync-store';
import {
  COUNT_COOLDOWN_MS,
  emptySkipCounts,
  type LastSync,
  lastSyncSchema,
  queuedRun,
  SYNC_STALE_MS,
  type SyncEstimate,
  type SyncRun,
  syncEstimateSchema,
  syncFingerprint,
  syncRunSchema,
  syncStartResultSchema,
  syncStatusSchema,
} from '@proton/module-joinroles/sync-view';
import { z } from 'zod';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { JoinRolesSyncService } from '../src/joinroles/sync.ts';
import type { AuditWrite } from '../src/leveling/xp-events.ts';
import type { ModuleConfigView } from '../src/modules/service.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const ADMIN = '100000000000000001';
const MEMBER_ROLE = '410000000000000001';
const BOT_ROLE = '410000000000000002';
const SKIP_ROLE = '410000000000000003';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-18T12:00:00.000Z');

const SYNC = `/guilds/${GUILD}/joinroles/sync`;

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const GONE = {
  presence: () => Promise.resolve({ present: [], known: true }),
};

class MemoryRunStore implements JoinRolesRunStore {
  readonly keys = new Map<string, string>();
  claims = 0;
  failClear = false;

  #read<T>(key: string, parse: (raw: unknown) => T): T | null {
    const raw = this.keys.get(key);
    return raw === undefined ? null : parse(JSON.parse(raw));
  }

  #current(guildId: string, runId: string): boolean {
    return this.#read(`run:${guildId}`, (raw) => syncRunSchema.parse(raw))?.runId === runId;
  }

  seedRun(run: SyncRun): this {
    this.keys.set(`run:${run.guildId}`, JSON.stringify(run));
    return this;
  }

  seedLast(guildId: string, last: LastSync): this {
    this.keys.set(`last:${guildId}`, JSON.stringify(last));
    return this;
  }

  seedEstimate(guildId: string, estimate: SyncEstimate): this {
    this.keys.set(`estimate:${guildId}`, JSON.stringify(estimate));
    return this;
  }

  async get(guildId: string): Promise<SyncRun | null> {
    return this.#read(`run:${guildId}`, (raw) => syncRunSchema.parse(raw));
  }

  async claim(run: SyncRun): Promise<boolean> {
    this.claims++;
    if (this.keys.has(`run:${run.guildId}`)) return false;

    this.keys.set(`run:${run.guildId}`, JSON.stringify(run));
    return true;
  }

  async putIfCurrent(run: SyncRun): Promise<boolean> {
    if (!this.#current(run.guildId, run.runId)) return false;

    this.keys.set(`run:${run.guildId}`, JSON.stringify(run));
    return true;
  }

  async clear(guildId: string, runId: string): Promise<boolean> {
    if (this.failClear) throw new Error('Connection is closed.');
    if (!this.#current(guildId, runId)) return false;

    this.keys.delete(`run:${guildId}`);
    return true;
  }

  async finish(guildId: string, runId: string, result: SyncFinish): Promise<boolean> {
    if (!this.#current(guildId, runId)) return false;

    if (result.last) this.keys.set(`last:${guildId}`, JSON.stringify(result.last));
    if (result.estimate) this.keys.set(`estimate:${guildId}`, JSON.stringify(result.estimate));
    this.keys.delete(`run:${guildId}`);
    return true;
  }

  async last(guildId: string): Promise<LastSync | null> {
    return this.#read(`last:${guildId}`, (raw) => lastSyncSchema.parse(raw));
  }

  async estimate(guildId: string): Promise<SyncEstimate | null> {
    return this.#read(`estimate:${guildId}`, (raw) => syncEstimateSchema.parse(raw));
  }

  async autosyncAt(guildId: string): Promise<number | null> {
    return this.#read(`autosync:${guildId}`, (raw) => z.number().parse(raw));
  }

  async setAutosyncAt(guildId: string, at: number): Promise<void> {
    this.keys.set(`autosync:${guildId}`, JSON.stringify(at));
  }
}

interface HarnessOptions {
  enabled?: boolean;
  config?: Partial<JoinrolesConfig>;
  runs?: MemoryRunStore | false;
  bus?: false;
  service?: false;
  failAudit?: boolean;
  failPublish?: boolean;
  guilds?: unknown;
}

function saved(config: Partial<JoinrolesConfig> = {}): JoinrolesConfig {
  return { ...joinrolesDefaultConfig, enabled: true, memberRoleIds: [MEMBER_ROLE], ...config };
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const audits: NewAuditTrailEntry[] = [];
  const events: ProtonEvent[] = [];
  const logs: string[] = [];
  const asked: string[][] = [];

  const config = saved(options.config);
  const runs = options.runs === false ? undefined : (options.runs ?? new MemoryRunStore());

  const modules = {
    get: async (guildId: string, moduleId: string): Promise<ModuleConfigView> => {
      asked.push([guildId, moduleId]);
      return {
        moduleId,
        enabled: options.enabled ?? true,
        config,
        schemaVersion: 3,
        migrated: false,
        tier: 'free',
        postables: [],
        simulations: [],
      };
    },
  };

  const audit: AuditWrite = async (entry) => {
    order.push('audit');
    if (options.failAudit) throw new Error('connection terminated unexpectedly');
    audits.push(JSON.parse(JSON.stringify(entry)));
  };

  const bus: EventBus = {
    publish: async (event) => {
      order.push('publish');
      if (options.failPublish) {
        throw new Error('READONLY You cannot write against a read only replica.');
      }
      events.push(JSON.parse(JSON.stringify(event)));
    },
    subscribe: () => {
      throw new Error('the api never subscribes');
    },
  };

  const service = new JoinRolesSyncService({
    modules,
    audit,
    ...(runs ? { runs } : {}),
    ...(options.bus === false ? {} : { bus }),
    logger: { error: (line: string) => logs.push(line), warn: (line: string) => logs.push(line) },
    now: () => NOW,
  });

  const app = createApiApp({
    guilds: options.guilds ?? HERE,
    ...(options.service === false ? {} : { joinrolesSync: service }),
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  return { app, runs, audits, events, order, logs, asked, config };
}

const NO_SECRET = Symbol('no secret');

function send(
  app: ReturnType<typeof createApiApp>,
  method: 'GET' | 'POST',
  options: { body?: unknown; secret?: string | typeof NO_SECRET } = {},
) {
  const secret = options.secret ?? SECRET;

  return app.request(SYNC, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const START = { kind: 'sync', actorId: ADMIN, source: 'dashboard', ipHash: 'hash123' };
const COUNT = { ...START, kind: 'count' };

interface Refusal {
  error: string;
  message: string;
  nextCountAt?: number;
}

async function refusal(response: Response): Promise<Refusal> {
  return (await response.json()) as Refusal;
}

function runningSync(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    ...queuedRun({
      runId: '01J00000000000000000000001',
      guildId: GUILD,
      kind: 'sync',
      trigger: 'dashboard',
      actorId: ADMIN,
      now: NOW - 5 * MINUTE,
    }),
    state: 'running',
    after: '200000000000000123',
    total: 5000,
    processed: 1200,
    updated: 84,
    skipped: { ...emptySkipCounts(), pending: 4, excluded: 2 },
    failures: 2,
    startedAt: NOW - 4 * MINUTE,
    heartbeatAt: NOW - 10_000,
    ...overrides,
  };
}

function estimate(overrides: Partial<SyncEstimate> = {}): SyncEstimate {
  return {
    missing: 312,
    pending: 20,
    scanned: 5000,
    countedAt: NOW - 2 * 60 * MINUTE,
    source: 'count',
    fingerprint: syncFingerprint(saved()),
    failure: null,
    ...overrides,
  };
}

const LAST: LastSync = {
  runId: 's12',
  trigger: 'schedule',
  outcome: 'failed',
  failure: {
    code: 'missing_permission',
    message:
      "Proton is missing the Manage Roles permission in this server. Turn it on for Proton's " +
      'role in Server Settings → Roles, then sync again.',
  },
  processed: 0,
  updated: 0,
  skipped: emptySkipCounts(),
  blockedRoles: [],
  startedAt: NOW - 60 * MINUTE,
  finishedAt: NOW - 59 * MINUTE,
};

describe('POST /guilds/:guildId/joinroles/sync', () => {
  test('is refused without the shared secret, before anything is read or claimed', async () => {
    const { app, runs, asked, audits, events } = harness();

    expect((await send(app, 'POST', { body: START, secret: NO_SECRET })).status).toBe(401);
    expect(asked).toHaveLength(0);
    expect(runs?.claims).toBe(0);
    expect(audits).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test('claims a queued run, writes the audit row, then publishes the request', async () => {
    const { app, runs, audits, events, order } = harness();

    const response = await send(app, 'POST', { body: START });
    expect(response.status).toBe(200);

    const { runId, kind } = syncStartResultSchema.parse(await response.json());
    expect(kind).toBe('sync');

    expect(order).toEqual(['audit', 'publish']);

    expect(await runs?.get(GUILD)).toEqual(
      queuedRun({
        runId,
        guildId: GUILD,
        kind: 'sync',
        trigger: 'dashboard',
        actorId: ADMIN,
        now: NOW,
      }),
    );

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      guildId: GUILD,
      actorId: ADMIN,
      source: 'dashboard',
      action: 'module.joinroles.sync.start',
      before: null,
      after: { runId, kind: 'sync' },
      ipHash: 'hash123',
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      id: `joinroles.sync_requested:${GUILD}:${runId}`,
      type: 'joinroles.sync_requested',
      guildId: GUILD,
      occurredAt: NOW,
    });
    expect(joinrolesSyncRequestedSchema.parse(event?.payload)).toEqual({
      auditId: audits[0]?.id ?? '',
      guildId: GUILD,
      runId,
      kind: 'sync',
      actorId: ADMIN,
    });
  });

  test('a count is audited as a count and carries its kind in the event', async () => {
    const { app, audits, events } = harness();

    const response = await send(app, 'POST', { body: COUNT });
    expect(response.status).toBe(200);

    const { runId } = syncStartResultSchema.parse(await response.json());
    expect(audits[0]).toMatchObject({
      action: 'module.joinroles.sync.count',
      after: { runId, kind: 'count' },
    });
    expect(joinrolesSyncRequestedSchema.parse(events[0]?.payload).kind).toBe('count');
  });

  test('bot roles alone are something to sync', async () => {
    const { app } = harness({ config: { memberRoleIds: [], botRoleIds: [BOT_ROLE] } });

    expect((await send(app, 'POST', { body: START })).status).toBe(200);
  });

  test('without an ip hash the audit row records none', async () => {
    const { app, audits } = harness();

    await send(app, 'POST', { body: { kind: 'sync', actorId: ADMIN } });

    expect(audits[0]).toMatchObject({ source: 'dashboard', ipHash: null });
  });

  test('refuses a body with an unknown kind, a non-snowflake actor or no body at all', async () => {
    const { app, runs, audits } = harness();

    for (const body of [{ ...START, kind: 'purge' }, { ...START, actorId: 'someone' }, null]) {
      const response = await send(app, 'POST', { body });

      expect(response.status).toBe(400);
      expect((await refusal(response)).error).toBe('invalid_body');
    }
    expect(runs?.claims).toBe(0);
    expect(audits).toHaveLength(0);
  });

  test('is refused with bot_absent when Proton is no longer in the server', async () => {
    const { app, runs, events } = harness({ guilds: GONE });

    const response = await send(app, 'POST', { body: START });

    expect(response.status).toBe(409);
    expect(await refusal(response)).toEqual({
      error: 'bot_absent',
      message:
        'Discord says Proton is not in this server, so nothing was started. Invite Proton back ' +
        'to the server and try again.',
    });
    expect(runs?.claims).toBe(0);
    expect(events).toHaveLength(0);
  });

  test('409 module_disabled when Join Roles is switched off, whichever switch is off', async () => {
    for (const options of [{ enabled: false }, { config: { enabled: false } }]) {
      const { app, runs, audits, events } = harness(options);

      const response = await send(app, 'POST', { body: START });
      const body = await refusal(response);

      expect(response.status).toBe(409);
      expect(body.error).toBe('module_disabled');
      expect(body.message).toBe(
        'Join Roles is off in this server, so no sync was started. Turn it on first.',
      );
      expect(runs?.claims).toBe(0);
      expect(audits).toHaveLength(0);
      expect(events).toHaveLength(0);
    }
  });

  test('400 nothing_to_sync when no member or bot roles are set', async () => {
    const { app, runs, audits } = harness({ config: { memberRoleIds: [], botRoleIds: [] } });

    const response = await send(app, 'POST', { body: START });
    const body = await refusal(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'nothing_to_sync',
      message:
        'No member or bot roles are set, so there is nothing to sync. Choose them and save first.',
    });
    expect(runs?.claims).toBe(0);
    expect(audits).toHaveLength(0);
  });

  test('409 already_running while a sync is going, with no audit row and no event', async () => {
    const held = runningSync();
    const { app, runs, audits, events } = harness({ runs: new MemoryRunStore().seedRun(held) });

    const response = await send(app, 'POST', { body: START });
    const body = await refusal(response);

    expect(response.status).toBe(409);
    expect(body.error).toBe('already_running');
    expect(body.message).toStartWith('A sync is already running in this server.');
    expect(audits).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(await runs?.get(GUILD)).toEqual(held);
  });

  test('a second press while the first is still queued is refused and changes nothing', async () => {
    const { app, audits, events } = harness();

    expect((await send(app, 'POST', { body: START })).status).toBe(200);
    const again = await send(app, 'POST', { body: START });

    expect(again.status).toBe(409);
    expect((await refusal(again)).error).toBe('already_running');
    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test('a queued run the worker never picked up is replaced once it has been silent too long', async () => {
    const lost = queuedRun({
      runId: 'lost-request',
      guildId: GUILD,
      kind: 'sync',
      trigger: 'dashboard',
      actorId: ADMIN,
      now: NOW - SYNC_STALE_MS,
    });
    const { app, runs, audits, events, logs } = harness({
      runs: new MemoryRunStore().seedRun(lost),
    });

    const response = await send(app, 'POST', { body: COUNT });

    expect(response.status).toBe(200);
    const { runId } = syncStartResultSchema.parse(await response.json());
    expect(await runs?.get(GUILD)).toMatchObject({ runId, kind: 'count', state: 'queued' });
    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(joinrolesSyncRequestedSchema.parse(events[0]?.payload).runId).toBe(runId);
    expect(logs.join('\n')).toContain('lost-request');
  });

  test('a running sync that stopped reporting progress is replaced too', async () => {
    const dead = runningSync({ heartbeatAt: NOW - 3 * 60 * MINUTE });
    const { app, runs } = harness({ runs: new MemoryRunStore().seedRun(dead) });

    const response = await send(app, 'POST', { body: START });

    expect(response.status).toBe(200);
    expect((await runs?.get(GUILD))?.runId).not.toBe(dead.runId);
  });

  test('a run that reported progress inside the window is still refused', async () => {
    for (const held of [
      runningSync({ state: 'queued', heartbeatAt: NOW - SYNC_STALE_MS + 1 }),
      runningSync({ heartbeatAt: NOW - SYNC_STALE_MS + 1 }),
    ]) {
      const { app, runs, audits, events } = harness({ runs: new MemoryRunStore().seedRun(held) });

      const response = await send(app, 'POST', { body: START });

      expect(response.status).toBe(409);
      expect((await refusal(response)).error).toBe('already_running');
      expect(await runs?.get(GUILD)).toEqual(held);
      expect(audits).toHaveLength(0);
      expect(events).toHaveLength(0);
    }
  });

  test('the already_running message says what is running and what can happen next', async () => {
    const counting = runningSync({ kind: 'count' });

    const cases = [
      [counting, START, 'You can sync when the count finishes.'],
      [counting, COUNT, 'Proton is already counting'],
      [runningSync(), COUNT, 'it updates the count when it finishes.'],
    ] as const;

    for (const [held, body, says] of cases) {
      const { app } = harness({ runs: new MemoryRunStore().seedRun(held) });

      expect((await refusal(await send(app, 'POST', { body }))).message).toContain(says);
    }
  });

  test('409 counted_recently inside the 10-minute cooldown, naming when it lifts', async () => {
    const countedAt = NOW - 4 * MINUTE;
    const runs = new MemoryRunStore().seedEstimate(GUILD, estimate({ countedAt }));
    const { app, audits, events } = harness({ runs });

    const response = await send(app, 'POST', { body: COUNT });
    const body = await refusal(response);

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'counted_recently',
      message:
        'Proton counted the members missing a join role less than 10 minutes ago. You can ' +
        'count again in 6 minutes.',
      nextCountAt: countedAt + COUNT_COOLDOWN_MS,
    });
    expect(runs.claims).toBe(0);
    expect(audits).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test('a count is allowed again once 10 minutes have passed', async () => {
    const runs = new MemoryRunStore().seedEstimate(
      GUILD,
      estimate({ countedAt: NOW - COUNT_COOLDOWN_MS }),
    );
    const { app } = harness({ runs });

    expect((await send(app, 'POST', { body: COUNT })).status).toBe(200);
  });

  test('a sync is not held back by the count cooldown', async () => {
    const runs = new MemoryRunStore().seedEstimate(GUILD, estimate({ countedAt: NOW - MINUTE }));
    const { app } = harness({ runs });

    expect((await send(app, 'POST', { body: START })).status).toBe(200);
  });

  test('503 no_redis without a run store, and nothing is audited or published', async () => {
    const { app, audits, events } = harness({ runs: false });

    const response = await send(app, 'POST', { body: START });
    const body = await refusal(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe('no_redis');
    expect(body.message).toContain('part of its service is down');
    expect(audits).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test('503 no_redis when the api was built without the sync service', async () => {
    const { app } = harness({ service: false });

    const response = await send(app, 'POST', { body: START });

    expect(response.status).toBe(503);
    expect((await refusal(response)).error).toBe('no_redis');
  });

  test('503 no_bus without an event bus, before any slot is claimed', async () => {
    const { app, runs, audits } = harness({ bus: false });

    const response = await send(app, 'POST', { body: START });
    const body = await refusal(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe('no_bus');
    expect(body.message).toContain('so no sync was started');
    expect(runs?.claims).toBe(0);
    expect(audits).toHaveLength(0);
  });

  test('a failed publish releases the slot, so the next press can start', async () => {
    const runs = new MemoryRunStore();
    const failing = harness({ runs, failPublish: true });

    const response = await send(failing.app, 'POST', { body: START });
    const body = await refusal(response);

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'not_started',
      message:
        'Proton can’t start a sync right now because part of its service is down, so no sync ' +
        'was started. Try again later.',
    });
    expect(failing.order).toEqual(['audit', 'publish']);
    expect(failing.events).toHaveLength(0);
    expect(await runs.get(GUILD)).toBeNull();
    expect(failing.logs.join('\n')).toContain('READONLY');

    expect((await send(harness({ runs }).app, 'POST', { body: START })).status).toBe(200);
  });

  test('a failed audit write releases the slot and publishes nothing', async () => {
    const { app, runs, events, order } = harness({ failAudit: true });

    const response = await send(app, 'POST', { body: COUNT });
    const body = await refusal(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe('not_started');
    expect(body.message).toContain('so nothing was counted');
    expect(order).toEqual(['audit']);
    expect(events).toHaveLength(0);
    expect(await runs?.get(GUILD)).toBeNull();
  });

  test('a slot that cannot be released is still refused as not_started and logged', async () => {
    const runs = new MemoryRunStore();
    runs.failClear = true;
    const { app, logs } = harness({ runs, failPublish: true });

    const response = await send(app, 'POST', { body: START });

    expect(response.status).toBe(503);
    expect((await refusal(response)).error).toBe('not_started');
    expect(logs.join('\n')).toContain('could not be released');
  });
});

describe('GET /guilds/:guildId/joinroles/sync', () => {
  test('is refused without the shared secret, before anything is read', async () => {
    const { app, asked } = harness();

    expect((await send(app, 'GET', { secret: NO_SECRET })).status).toBe(401);
    expect(asked).toHaveLength(0);
  });

  test('answers nulls and the server clock for a server that never synced', async () => {
    const { app } = harness();

    const response = await send(app, 'GET');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: null,
      last: null,
      estimate: null,
      nextCountAt: null,
      now: NOW,
    });
  });

  test('shows a running sync without its cursor or retry counter', async () => {
    const held = runningSync();
    const { app } = harness({ runs: new MemoryRunStore().seedRun(held) });

    const body = (await (await send(app, 'GET')).json()) as { run: Record<string, unknown> };
    const status = syncStatusSchema.parse(body);

    expect(body.run).not.toHaveProperty('after');
    expect(body.run).not.toHaveProperty('failures');
    expect(status.run).toMatchObject({
      runId: held.runId,
      kind: 'sync',
      trigger: 'dashboard',
      actorId: ADMIN,
      state: 'running',
      total: 5000,
      processed: 1200,
      updated: 84,
      skipped: { pending: 4, excluded: 2 },
    });
  });

  test('returns the last sync as the worker wrote it', async () => {
    const { app } = harness({ runs: new MemoryRunStore().seedLast(GUILD, LAST) });

    expect(syncStatusSchema.parse(await (await send(app, 'GET')).json()).last).toEqual(LAST);
  });

  test('an estimate counted against the saved roles is not stale', async () => {
    const { app } = harness({ runs: new MemoryRunStore().seedEstimate(GUILD, estimate()) });

    const status = syncStatusSchema.parse(await (await send(app, 'GET')).json());

    expect(status.estimate).toEqual({ ...estimate(), stale: false });
    expect(status.nextCountAt).toBeNull();
    expect(status.now).toBe(NOW);
  });

  test('an estimate goes stale when the roles changed after it was counted', async () => {
    const runs = new MemoryRunStore().seedEstimate(GUILD, estimate());

    for (const config of [
      { memberRoleIds: [MEMBER_ROLE, BOT_ROLE] },
      { syncExcludeEnabled: true, syncExcludeRoleIds: [SKIP_ROLE] },
      { grantWhenScreeningPasses: false },
    ]) {
      const { app } = harness({ runs, config });

      expect(syncStatusSchema.parse(await (await send(app, 'GET')).json()).estimate?.stale).toBe(
        true,
      );
    }
  });

  test('skip roles saved while their switch is off do not make the estimate stale', async () => {
    const runs = new MemoryRunStore().seedEstimate(GUILD, estimate());
    const { app } = harness({ runs, config: { syncExcludeRoleIds: [SKIP_ROLE] } });

    expect(syncStatusSchema.parse(await (await send(app, 'GET')).json()).estimate?.stale).toBe(
      false,
    );
  });

  test('names when the next count is allowed while the cooldown runs', async () => {
    const countedAt = NOW - 3 * MINUTE;
    const { app } = harness({
      runs: new MemoryRunStore().seedEstimate(GUILD, estimate({ countedAt })),
    });

    const status = syncStatusSchema.parse(await (await send(app, 'GET')).json());

    expect(status.nextCountAt).toBe(countedAt + COUNT_COOLDOWN_MS);
  });

  test('is not behind the write-presence guard, so a server Proton left can still be read', async () => {
    const { app } = harness({ guilds: GONE });

    expect((await send(app, 'GET')).status).toBe(200);
  });

  test('503 no_redis without a run store', async () => {
    const { app } = harness({ runs: false });

    const response = await send(app, 'GET');

    expect(response.status).toBe(503);
    expect((await refusal(response)).error).toBe('no_redis');
  });
});
