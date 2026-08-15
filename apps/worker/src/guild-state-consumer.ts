import {
  buildGuildState,
  type EventBus,
  type EventType,
  type GuildStateStore,
  type Logger,
  type Subscription,
} from '@proton/core';

const TYPES: EventType[] = ['guild.available', 'guild.unavailable'];

/**
 * How the worker records a guild's existence. A port, so the consumer's tests
 * do not need an API server standing up.
 */
export interface GuildRegistrar {
  ensure(
    guildId: string,
    name: string,
    extra?: { locale?: string; shardId?: number },
  ): Promise<void>;
  markLeft(guildId: string): Promise<void>;
}

/**
 * Keeps the guild state cache current from the event bus.
 *
 * The gateway normalises; the worker owns state. That split matters for I13 —
 * the gateway must be able to restart without re-deriving anything, and state
 * rebuilding must not be a reason to redeploy it.
 *
 * PLAN.md §10.4: state is seeded from GUILD_CREATE and thereafter maintained
 * incrementally. Request Guild Members (all-members form) is 1 per guild per 30
 * seconds and is never used here.
 */
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

    if (event.type === 'guild.unavailable') {
      if (!event.guildId) return;
      await this.#store.delete(event.guildId);

      /**
       * GUILD_DELETE means two different things. With `unavailable: true` the
       * guild is having an outage and the bot is still a member; without it, the
       * bot was actually removed. Marking `left_at` on an outage would retire a
       * guild that is about to come straight back, so only the second case
       * counts as leaving.
       */
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
      // GUILD_CREATE only carries members up to `large_threshold`, so the bot's
      // own member may be absent. Left empty, its highest role position reads as
      // 0 and every hierarchy check fails closed — safe, but it would refuse
      // every action, so this is worth surfacing rather than swallowing.
      this.#logger.warn('bot member absent from GUILD_CREATE; hierarchy checks will refuse', {
        guildId: state.guildId,
      });
    }

    /**
     * Register before caching. `guild_modules.guild_id` is a foreign key to
     * `guilds`, so until this row exists no module can be enabled and every
     * config read reports `enabled: false` — the bot sits in the server looking
     * healthy and answering nothing.
     *
     * Failure here is fatal to the event on purpose: it propagates, the bus
     * leaves the message unacked, and it is retried. Caching state for a guild
     * the database does not know about would leave the bot in exactly the broken
     * state this fixes, but with the logs saying everything worked.
     */
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
