import {
  buildGuildState,
  type EventBus,
  type EventType,
  type GuildStateStore,
  type Logger,
  type Subscription,
} from '@proton/core';

const TYPES: EventType[] = [
  'guild.available',
  'guild.unavailable',
  // Only to keep member_count current. GUILD_CREATE's reading is a point in time, and a welcome
  // message that says "#0" is the visible cost of not tracking it.
  'member.joined',
  'member.left',
];

export interface GuildRegistrar {
  ensure(
    guildId: string,
    name: string,
    extra?: { locale?: string; shardId?: number },
  ): Promise<void>;
  markLeft(guildId: string): Promise<void>;
}

export class GuildStateConsumer {
  readonly #bus: EventBus;
  readonly #store: GuildStateStore;
  readonly #registrar: GuildRegistrar;
  readonly #botUserId: string;
  readonly #logger: Logger;

  constructor(deps: {
    bus: EventBus;
    store: GuildStateStore;
    registrar: GuildRegistrar;
    botUserId: string;
    logger: Logger;
  }) {
    this.#bus = deps.bus;
    this.#store = deps.store;
    this.#registrar = deps.registrar;
    this.#botUserId = deps.botUserId;
    this.#logger = deps.logger;
  }

  start(): Subscription {
    return this.#bus.subscribe('guild-state', TYPES, (event) => this.handle(event));
  }

  async handle(event: { type: string; guildId: string | null; payload: unknown }): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === 'member.joined' || event.type === 'member.left') {
      if (!event.guildId) return;
      await this.#store.patch(event.guildId, {
        kind: 'member.count',
        delta: event.type === 'member.joined' ? 1 : -1,
      });
      return;
    }

    if (event.type === 'guild.unavailable') {
      if (!event.guildId) return;
      await this.#store.delete(event.guildId);

      if (payload.unavailable !== true) {
        await this.#registrar.markLeft(event.guildId);
      }
      return;
    }

    const state = buildGuildState(event.payload as Record<string, unknown>, this.#botUserId);
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
  }
}
