import {
  type EventBus,
  type EventType,
  type Logger,
  type ProtonEvent,
  protonCommandsChangedSchema,
  protonConfigChangedSchema,
  type RestProxyClient,
  type Subscription,
} from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import {
  type CommandRecordCache,
  type CommandRegistrationRail,
  type CommandSyncer,
  type CommandSyncQueue,
  DISCORD_READ_TIMEOUT_MS,
  failureClass,
  inRegistrationScope,
  type RegistrationStore,
  type Retirement,
} from './command-sync.ts';
import type { GuildCommandSync, GuildRegistrar } from './guild-state-consumer.ts';
import { logQueueConnectionErrors } from './job-errors.ts';

export const COMMAND_SYNC_GROUP = 'command-sync';
export const COMMAND_SYNC_QUEUE = 'proton-command-sync';
export const COMMAND_SYNC_SWEEP_JOB = 'sweep';
export const COMMAND_SYNC_SWEEP_MS = 600_000;
export const SWEEP_LIMIT = 500;
export const BOOT_RETRY_BASE_MS = 5_000;
export const BOOT_RETRY_CAP_MS = 300_000;

const TYPES: EventType[] = ['proton.commands_changed', 'proton.config_changed'];

const REQUEUED_BLOCKERS: ReadonlySet<string> = new Set([
  'unsynced',
  'permissions-unchecked',
  'pending',
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PAGE_SIZE = 200;
const MAX_PAGES = 250;

function isGuild(value: unknown): value is { id: string; name: string } {
  if (typeof value !== 'object' || value === null) return false;
  const guild = value as { id?: unknown; name?: unknown };
  return typeof guild.id === 'string' && typeof guild.name === 'string';
}

export async function discordGuilds(rest: RestProxyClient): Promise<Map<string, string>> {
  const guilds = new Map<string, string>();
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (after !== undefined) query.set('after', after);

    const response = await rest.request({
      method: 'GET',
      path: `/users/@me/guilds?${query.toString()}`,
      timeoutMs: DISCORD_READ_TIMEOUT_MS,
    });

    if (response.status >= 400) {
      throw new Error(
        `Discord answered ${response.status} when Proton asked which servers it is in.`,
      );
    }
    if (!Array.isArray(response.body)) {
      throw new Error('Discord answered the bot server list with something other than a list.');
    }

    const listed = response.body.filter(isGuild);
    for (const guild of listed) guilds.set(guild.id, guild.name);

    const last = listed.at(-1);
    if (response.body.length < PAGE_SIZE || !last) return guilds;
    after = last.id;
  }

  throw new Error(
    `Proton is in more than ${MAX_PAGES * PAGE_SIZE} servers, which this lookup cannot page through.`,
  );
}

export interface CommandSyncTriggersDeps {
  bus: EventBus;
  rest: RestProxyClient;
  rail: CommandRegistrationRail;
  queue: Pick<CommandSyncQueue, 'enqueue' | 'cancel' | 'idle'>;
  syncer: Pick<CommandSyncer, 'retireGlobal' | 'globalRetired'>;
  records: Pick<CommandRecordCache, 'get' | 'stored' | 'delete'>;
  store: Pick<RegistrationStore, 'forget' | 'staleGuilds'>;
  registrar: Pick<GuildRegistrar, 'ensure'>;
  settings?: { invalidate(guildId: string): void };
  logger: Logger;
  sweepLimit?: number;
  sleep?: (ms: number) => Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CommandSyncTriggers implements GuildCommandSync {
  readonly #deps: CommandSyncTriggersDeps;

  constructor(deps: CommandSyncTriggersDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(COMMAND_SYNC_GROUP, TYPES, (event) => this.handle(event), {
      startId: '$',
    });
  }

  async handle(event: ProtonEvent): Promise<void> {
    const { queue, rail, settings, logger } = this.#deps;

    if (event.type === 'proton.commands_changed') {
      const parsed = protonCommandsChangedSchema.safeParse(event.payload);
      if (!parsed.success) {
        logger.warn('ignored a proton.commands_changed event in an unknown shape', {
          id: event.id,
        });
        return;
      }

      settings?.invalidate(parsed.data.guildId);
      if (parsed.data.registration && inRegistrationScope(rail, parsed.data.guildId)) {
        queue.enqueue(parsed.data.guildId, { lane: 'interactive', liftAccess: true });
      }
      return;
    }

    if (event.type === 'proton.config_changed') {
      const parsed = protonConfigChangedSchema.safeParse(event.payload);
      if (!parsed.success) {
        logger.warn('ignored a proton.config_changed event in an unknown shape', { id: event.id });
        return;
      }

      const { guildId, enabledBefore, enabledAfter, changedKeys } = parsed.data;
      settings?.invalidate(guildId);
      if (
        (enabledBefore !== enabledAfter || changedKeys.includes('enabled')) &&
        inRegistrationScope(rail, guildId)
      ) {
        queue.enqueue(guildId, { lane: 'interactive', liftAccess: true });
      }
    }
  }

  async available(guildId: string, joinedAt: string | null): Promise<void> {
    if (!inRegistrationScope(this.#deps.rail, guildId)) return;

    let force = true;
    try {
      const record = await this.#deps.records.get(guildId);
      const joined = joinedAt === null ? Number.NaN : Date.parse(joinedAt);
      const synced = record?.syncedAt ? Date.parse(record.syncedAt) : Number.NaN;

      force =
        record === null ||
        (!Number.isNaN(joined) && (Number.isNaN(synced) || joined > synced)) ||
        (record.failure !== null && failureClass(record.failure) === 'access');
    } catch (error) {
      this.#deps.logger.warn(
        `could not read server ${guildId}'s command registration, so its commands are registered ` +
          `again: ${describe(error)}`,
        { guildId },
      );
    }

    this.#deps.queue.enqueue(guildId, { lane: 'interactive', skipHash: force, ignoreHolds: force });
  }

  async forget(guildId: string): Promise<void> {
    this.#deps.queue.cancel(guildId);
    await this.#deps.store.forget(guildId);
    this.#deps.records.delete(guildId);
    this.#deps.settings?.invalidate(guildId);
  }

  async bootFanOut(): Promise<void> {
    const { rail, queue, logger } = this.#deps;

    const guilds = await this.#bootGuildList();

    const ids = [...guilds.keys()].filter((guildId) => inRegistrationScope(rail, guildId));
    if (rail.scope === 'guild' && ids.length === 0) {
      logger.warn(
        `Proton is not in DISCORD_TEST_GUILD_ID (${rail.testGuildId ?? 'unset'}), so no commands ` +
          'were registered. Invite it there from the dashboard.',
      );
    }

    logger.info(`checking the commands of ${ids.length} server(s)`);
    for (const guildId of ids) {
      if (await this.#ensureRow(guildId, guilds.get(guildId) ?? guildId)) {
        queue.enqueue(guildId, { lane: 'bulk' });
      }
    }

    await queue.idle();
    logger.info(`finished checking the commands of ${ids.length} server(s)`);

    await this.#retire(ids, guilds);
  }

  async #bootGuildList(): Promise<Map<string, string>> {
    const wait = this.#deps.sleep ?? sleep;

    for (let delay = BOOT_RETRY_BASE_MS; ; delay = Math.min(BOOT_RETRY_CAP_MS, delay * 2)) {
      try {
        return await discordGuilds(this.#deps.rest);
      } catch (error) {
        this.#deps.logger.error(
          'could not read which servers Proton is in, so the boot check of their commands ' +
            `waits ${Math.round(delay / 1000)} s and asks again: ${describe(error)}`,
        );
      }
      await wait(delay);
    }
  }

  async sweep(): Promise<void> {
    const { rail, queue, store, syncer, rest, logger } = this.#deps;
    const only = rail.scope === 'guild' ? rail.testGuildId : undefined;
    if (rail.scope === 'guild' && !only) return;

    const stale = (
      await store.staleGuilds(this.#deps.sweepLimit ?? SWEEP_LIMIT, {
        ...(only ? { onlyGuildId: only } : {}),
        includeUnchecked: !syncer.globalRetired,
      })
    ).filter((guildId) => inRegistrationScope(rail, guildId));
    for (const guildId of stale) queue.enqueue(guildId, { lane: 'bulk' });
    if (stale.length > 0) {
      logger.info(`the command sweep found ${stale.length} server(s) that may be out of date`);
    }

    if (syncer.globalRetired) return;

    await queue.idle();
    let guilds: Map<string, string>;
    try {
      guilds = await discordGuilds(rest);
    } catch (error) {
      logger.warn(
        'could not read which servers Proton is in, so the global commands were not checked ' +
          `for retirement: ${describe(error)}`,
      );
      return;
    }

    await this.#retire(
      [...guilds.keys()].filter((guildId) => inRegistrationScope(rail, guildId)),
      guilds,
    );
  }

  async #retire(guildIds: readonly string[], names: ReadonlyMap<string, string>): Promise<void> {
    const first = await this.#checkRetirement(guildIds);
    const requeued =
      first?.status === 'kept'
        ? first.blockers.filter((blocker) => REQUEUED_BLOCKERS.has(blocker.reason))
        : [];
    if (requeued.length === 0) return;

    this.#deps.logger.info(
      `checking ${requeued.length} server(s) again that held up retiring the global commands`,
    );
    for (const { guildId } of requeued) {
      if (await this.#ensureRow(guildId, names.get(guildId) ?? guildId)) {
        this.#deps.queue.enqueue(guildId, { lane: 'bulk' });
      }
    }

    await this.#deps.queue.idle();
    await this.#checkRetirement(guildIds);
  }

  async #checkRetirement(guildIds: readonly string[]): Promise<Retirement | null> {
    if (this.#deps.syncer.globalRetired) return null;
    try {
      return await this.#deps.syncer.retireGlobal(guildIds);
    } catch (error) {
      this.#deps.logger.error(
        `could not check the global commands for retirement: ${describe(error)}`,
      );
      return null;
    }
  }

  async #ensureRow(guildId: string, name: string): Promise<boolean> {
    let known = false;
    try {
      known = (await this.#deps.records.stored(guildId)) !== null;
    } catch {
      known = false;
    }
    if (known) return true;

    try {
      await this.#deps.registrar.ensure(guildId, name);
      return true;
    } catch (error) {
      this.#deps.logger.warn(
        `could not record server ${guildId}, so its commands were not checked: ${describe(error)}`,
        { guildId },
      );
      return false;
    }
  }
}

export interface CommandSyncSweep {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

export function startCommandSyncSweep(deps: {
  connection: ConnectionOptions;
  sweep(): Promise<void>;
  logger: Logger;
  intervalMs?: number;
}): CommandSyncSweep {
  const queue = new Queue(COMMAND_SYNC_QUEUE, { connection: deps.connection });
  const worker = new Worker(COMMAND_SYNC_QUEUE, () => deps.sweep(), {
    connection: deps.connection,
  });

  worker.on('failed', (_job, error) => {
    deps.logger.error(`the command sync sweep failed: ${error.message}`, { stack: error.stack });
  });

  logQueueConnectionErrors('the command sync sweep', deps.logger, queue, worker);

  void queue
    .upsertJobScheduler(COMMAND_SYNC_SWEEP_JOB, { every: deps.intervalMs ?? COMMAND_SYNC_SWEEP_MS })
    .catch((error: unknown) => {
      deps.logger.error(
        'could not register the command sync sweep — a command change whose event was lost is ' +
          `not registered until the next worker boot: ${describe(error)}`,
      );
    });

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
