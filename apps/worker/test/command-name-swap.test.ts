import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type CommandDefinition,
  commandCatalogue,
  type EventBus,
  type ModuleManifest,
  ModuleRegistry,
  type ProtonEvent,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  RestTimeoutError,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { banCommand, warnCommand } from '@proton/module-moderation';
import { z } from 'zod';
import { CommandResolver, UPDATING_REFUSAL } from '../src/command-resolver.ts';
import {
  CommandRecordCache,
  type CommandRegistrationRail,
  CommandSyncer,
} from '../src/command-sync.ts';
import { ModuleRuntime } from '../src/runtime.ts';
import {
  APPLICATION,
  collectingLogger,
  FakeDiscord,
  MemoryRegistrations,
  MemoryViews,
  TEST_GUILD,
  viewOf,
} from './command-fakes.ts';

const RAIL: CommandRegistrationRail = {
  applicationId: APPLICATION,
  scope: 'guild',
  testGuildId: TEST_GUILD,
};

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: () => ({ group: 'x', close: async () => undefined }),
};

class LandsThenTimesOut implements RestProxyClient {
  timeouts = 1;

  constructor(readonly discord: FakeDiscord) {}

  async request(options: RestRequestOptions): Promise<RestResponse> {
    const response = await this.discord.request(options);
    if (options.method === 'PUT' && this.timeouts > 0) {
      this.timeouts -= 1;
      throw new RestTimeoutError('PUT', options.path, 60_000);
    }
    return response;
  }
}

class HeldPut implements RestProxyClient {
  hold = false;
  readonly started = Promise.withResolvers<void>();
  readonly #released = Promise.withResolvers<void>();

  constructor(readonly discord: FakeDiscord) {}

  release(): void {
    this.#released.resolve();
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    if (options.method === 'PUT' && this.hold) {
      this.started.resolve();
      await this.#released.promise;
    }
    return this.discord.request(options);
  }
}

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return { status: 'executed' };
  }
}

function moderation(ran: string[]): ModuleRegistry {
  const spied = <C>(command: CommandDefinition<C>): CommandDefinition<C> => ({
    ...command,
    handler: async () => {
      ran.push(command.name);
    },
  });

  const registry = new ModuleRegistry();
  registry.register({
    id: 'moderation',
    name: 'Moderation',
    category: 'moderation',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    actionKinds: ['interaction_reply'],
    commands: [spied(banCommand({} as never)), spied(warnCommand({} as never))],
  } as unknown as ModuleManifest);
  return registry;
}

function banAsWarn(commandId: string, interactionId: string): ProtonEvent {
  const raw = dispatch('interactionCreateGuildCommand');
  raw.d.id = interactionId;
  (raw.d.data as Record<string, unknown>).id = commandId;
  const event = normalise(raw)[0];
  if (!event) throw new Error('interactionCreateGuildCommand did not normalise');
  return event;
}

function swapped(rest: RestProxyClient) {
  const ran: string[] = [];
  const reconciles: string[] = [];
  const registry = moderation(ran);
  const catalogue = commandCatalogue(registry);
  const store = new MemoryRegistrations();
  const records = new CommandRecordCache(store);
  const views = new MemoryViews();
  const { logger } = collectingLogger();
  const executor = new RecordingExecutor();

  views.views.set(
    TEST_GUILD,
    viewOf(
      { moderation: true },
      {
        ban: { name: 'hammer', updatedAt: '2026-09-22T00:00:00.000Z' },
        warn: { name: 'ban', updatedAt: '2026-09-22T00:01:00.000Z' },
      },
    ),
  );

  const clock = { now: Date.parse('2026-09-22T12:00:00.000Z') };
  const syncer = new CommandSyncer({
    rest,
    rail: RAIL,
    catalogue,
    views,
    store,
    records,
    logger,
    now: () => clock.now,
  });
  const resolver = new CommandResolver({
    catalogue,
    records,
    logger,
    reconcile: (guildId) => reconciles.push(guildId),
  });
  const runtime = new ModuleRuntime({
    bus,
    registry,
    executor,
    config: { get: async () => ({ enabled: true, config: { enabled: true } }) },
    logger,
    resolver,
  });

  return { ran, reconciles, store, views, syncer, runtime, executor, clock };
}

function payloadText(request: ActionRequest | undefined): string {
  const payload = request?.payload as { embeds?: Array<{ description?: string }> } | undefined;
  return payload?.embeds?.[0]?.description ?? '';
}

describe('warn renamed to /ban after ban was renamed away, before the first sync landed', () => {
  test('a PUT that timed out after Discord applied it never lets /ban run the ban handler', async () => {
    const discord = new FakeDiscord();
    const { ran, reconciles, store, syncer, runtime, executor, clock } = swapped(
      new LandsThenTimesOut(discord),
    );

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
    expect(store.records.get(TEST_GUILD)?.failure?.status).toBeNull();
    const onDiscord = discord.guildCommands.get(TEST_GUILD) ?? [];
    expect(onDiscord.map((command) => command.name).sort()).toEqual(['ban', 'hammer']);
    const warnId = onDiscord.find((command) => command.name === 'ban')?.id ?? '';

    await runtime.handle(banAsWarn(warnId, '1500000000000000031'));

    expect(ran).toEqual([]);
    expect(payloadText(executor.requests[0])).toContain(UPDATING_REFUSAL);
    expect(reconciles).toEqual([TEST_GUILD]);

    clock.now += 6_000;
    expect((await syncer.reconcile(TEST_GUILD, { skipHash: true })).status).toBe('registered');
    await runtime.handle(banAsWarn(warnId, '1500000000000000032'));

    expect(ran).toEqual(['warn']);
  });

  test('a PUT Discord took but the store could not record still routes /ban to warn', async () => {
    const discord = new FakeDiscord();
    const { ran, reconciles, store, syncer, runtime } = swapped(discord);
    store.recordSuccess = async () => {
      throw new Error('database unreachable');
    };

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    const warnId =
      discord.guildCommands.get(TEST_GUILD)?.find((command) => command.name === 'ban')?.id ?? '';

    await runtime.handle(banAsWarn(warnId, '1500000000000000033'));

    expect(ran).toEqual(['warn']);
    expect(reconciles).toEqual([]);
  });

  test('the ids the store never took survive the next reconcile while its PUT is out', async () => {
    const discord = new FakeDiscord();
    const rest = new HeldPut(discord);
    const { ran, reconciles, store, syncer, runtime } = swapped(rest);
    const recordSuccess = store.recordSuccess.bind(store);
    let failures = 1;
    store.recordSuccess = async (guildId, input) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('database unreachable');
      }
      return recordSuccess(guildId, input);
    };

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    expect(store.records.get(TEST_GUILD)).toBeUndefined();
    const warnId =
      discord.guildCommands.get(TEST_GUILD)?.find((command) => command.name === 'ban')?.id ?? '';

    rest.hold = true;
    const second = syncer.reconcile(TEST_GUILD);
    await rest.started.promise;
    await runtime.handle(banAsWarn(warnId, '1500000000000000034'));
    rest.release();

    expect((await second).status).toBe('registered');
    expect(ran).toEqual(['warn']);
    expect(reconciles).toEqual([]);
    expect(store.records.get(TEST_GUILD)?.idHistory[warnId]).toBe('warn');

    await runtime.handle(banAsWarn(warnId, '1500000000000000035'));
    expect(ran).toEqual(['warn', 'warn']);
  });

  test('ids the store never took are sent with the next PUT, so renaming back cannot move them', async () => {
    const discord = new FakeDiscord();
    const { store, views, syncer } = swapped(discord);
    const recordSuccess = store.recordSuccess.bind(store);
    let failures = 1;
    store.recordSuccess = async (guildId, input) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('database unreachable');
      }
      return recordSuccess(guildId, input);
    };

    await syncer.reconcile(TEST_GUILD);
    const idOf = (name: string) =>
      discord.guildCommands.get(TEST_GUILD)?.find((command) => command.name === name)?.id;
    const banId = idOf('hammer');
    const warnId = idOf('ban');

    views.views.set(TEST_GUILD, viewOf({ moderation: true }));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');

    expect(idOf('ban')).toBe(banId);
    expect(idOf('warn')).toBe(warnId);
    expect(store.records.get(TEST_GUILD)?.idHistory).toMatchObject({
      [banId ?? '']: 'ban',
      [warnId ?? '']: 'warn',
    });
  });
});
