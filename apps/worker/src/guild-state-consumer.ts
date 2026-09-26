import {
  buildGuildState,
  type EventBus,
  type EventType,
  type GuildStateStore,
  type Logger,
  parseChannel,
  parseGuildProfile,
  type Subscription,
} from '@proton/core';

const CHANNEL_LIFECYCLE_TYPES = [
  'entity.channel_created',
  'entity.channel_updated',
  'entity.channel_deleted',
  'entity.thread_created',
  'entity.thread_updated',
  'entity.thread_deleted',
] as const satisfies readonly EventType[];

type ChannelLifecycleEventType = (typeof CHANNEL_LIFECYCLE_TYPES)[number];

type ChannelLifecycle = 'upsert' | 'remove';

const LIFECYCLE: Record<ChannelLifecycleEventType, ChannelLifecycle> = {
  'entity.channel_created': 'upsert',
  'entity.channel_updated': 'upsert',
  'entity.channel_deleted': 'remove',
  'entity.thread_created': 'upsert',
  'entity.thread_updated': 'upsert',
  'entity.thread_deleted': 'remove',
};

const LIFECYCLE_BY_TYPE: ReadonlyMap<string, ChannelLifecycle> = new Map(Object.entries(LIFECYCLE));

const TYPES: EventType[] = [
  'guild.available',
  'guild.unavailable',
  'entity.guild_updated',
  // Only to keep member_count current. GUILD_CREATE's reading is a point in time, and a welcome
  // message that says "#0" is the visible cost of not tracking it.
  'member.joined',
  'member.left',
  ...CHANNEL_LIFECYCLE_TYPES,
];

export interface GuildRegistrar {
  ensure(
    guildId: string,
    name: string,
    extra?: { locale?: string; shardId?: number },
  ): Promise<void>;
  markLeft(guildId: string): Promise<boolean>;
}

export interface RemovedGuildCleanup {
  cron: { unregister(guildId: string): Promise<number> };
  commands?: { forget(guildId: string): Promise<void> };
}

export interface GuildCommandSync {
  available(guildId: string, joinedAt: string | null): Promise<void>;
}

export class GuildStateConsumer {
  readonly #bus: EventBus;
  readonly #store: GuildStateStore;
  readonly #registrar: GuildRegistrar;
  readonly #botUserId: string;
  readonly #logger: Logger;
  readonly #removal: RemovedGuildCleanup | undefined;
  readonly #commands: GuildCommandSync | undefined;

  constructor(deps: {
    bus: EventBus;
    store: GuildStateStore;
    registrar: GuildRegistrar;
    botUserId: string;
    logger: Logger;
    removal?: RemovedGuildCleanup;
    commands?: GuildCommandSync;
  }) {
    this.#bus = deps.bus;
    this.#store = deps.store;
    this.#registrar = deps.registrar;
    this.#botUserId = deps.botUserId;
    this.#logger = deps.logger;
    this.#removal = deps.removal;
    this.#commands = deps.commands;
  }

  async #removed(guildId: string): Promise<void> {
    if (!(await this.#registrar.markLeft(guildId))) {
      this.#logger.info(
        'Discord still lists Proton in this server, so this removal is older than a rejoin and ' +
          'nothing was forgotten.',
        { guildId },
      );
      return;
    }

    await this.#store.delete(guildId);
    const unscheduled = (await this.#removal?.cron.unregister(guildId)) ?? 0;
    await this.#removal?.commands?.forget(guildId);

    this.#logger.info(
      'Proton was removed from this server. Its cron rules were stopped and come back if it is ' +
        'added again; its scheduled actions and stored data stay until deletion is requested.',
      { guildId, removedCronRules: unscheduled },
    );
  }

  start(): Subscription {
    return this.#bus.subscribe('guild-state', TYPES, (event) => this.handle(event));
  }

  async #applyChannel(
    guildId: string | null,
    lifecycle: ChannelLifecycle,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!guildId) return;

    if (lifecycle === 'remove') {
      const channelId = typeof payload.id === 'string' ? payload.id : null;
      if (!channelId) return;

      await this.#store.patch(guildId, { kind: 'channel.delete', channelId });
      return;
    }

    const channel = parseChannel(payload);
    if (!channel) return;

    // Lands over the bus, so a same-tick use misses state; the precheck fails closed on a miss.
    await this.#store.patch(guildId, { kind: 'channel.upsert', channel });
  }

  async handle(event: {
    id: string;
    type: string;
    guildId: string | null;
    occurredAt?: number;
    payload: unknown;
  }): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    // Gateway time, not ours: per-type streams can hand us a GUILD_UPDATE after a staler GUILD_CREATE.
    const occurredAt = event.occurredAt ?? Date.now();

    const lifecycle = LIFECYCLE_BY_TYPE.get(event.type);
    if (lifecycle) {
      await this.#applyChannel(event.guildId, lifecycle, payload);
      return;
    }

    if (event.type === 'entity.guild_updated') {
      if (!event.guildId) return;
      await this.#store.patch(event.guildId, {
        kind: 'guild.profile',
        at: occurredAt,
        profile: parseGuildProfile(payload),
      });
      return;
    }

    if (event.type === 'member.joined' || event.type === 'member.left') {
      if (!event.guildId) return;
      await this.#store.patch(
        event.guildId,
        { kind: 'member.count', delta: event.type === 'member.joined' ? 1 : -1 },
        { dedupeKey: event.id },
      );
      return;
    }

    if (event.type === 'guild.unavailable') {
      if (!event.guildId) return;

      if (payload.unavailable === true) {
        await this.#store.delete(event.guildId);
      } else {
        await this.#removed(event.guildId);
      }
      return;
    }

    const state = buildGuildState(payload, this.#botUserId, occurredAt);
    if (!state) {
      this.#logger.warn('guild.available payload did not yield usable state', {
        guildId: event.guildId,
      });
      return;
    }

    if (state.botRoleIds.length === 0) {
      this.#logger.warn('bot member absent from GUILD_CREATE; hierarchy checks will refuse', {
        guildId: state.guildId,
      });
    }

    await this.#registrar.ensure(
      state.guildId,
      typeof payload.name === 'string' ? payload.name : state.guildId,
      {
        ...(typeof payload.preferred_locale === 'string'
          ? { locale: payload.preferred_locale }
          : {}),
        ...(Array.isArray(payload.shard) && typeof payload.shard[0] === 'number'
          ? { shardId: payload.shard[0] }
          : {}),
      },
    );

    await this.#store.put(state);
    this.#logger.info('guild registered and state cached', {
      guildId: state.guildId,
      roles: state.roles.size,
      channels: state.channels.size,
    });

    await this.#commands?.available(
      state.guildId,
      typeof payload.joined_at === 'string' ? payload.joined_at : null,
    );
  }
}
