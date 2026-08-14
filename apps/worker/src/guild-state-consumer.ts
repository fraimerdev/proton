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
  readonly #botUserId: string;
  readonly #logger: Logger;

  constructor(deps: {
    bus: EventBus;
    store: GuildStateStore;
    botUserId: string;
    logger: Logger;
  }) {
    this.#bus = deps.bus;
    this.#store = deps.store;
    this.#botUserId = deps.botUserId;
    this.#logger = deps.logger;
  }

  start(): Subscription {
    return this.#bus.subscribe('guild-state', TYPES, (event) => this.handle(event));
  }

  async handle(event: { type: string; guildId: string | null; payload: unknown }): Promise<void> {
    if (event.type === 'guild.unavailable') {
      if (event.guildId) await this.#store.delete(event.guildId);
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

    await this.#store.put(state);
    this.#logger.info('guild state cached', {
      guildId: state.guildId,
      roles: state.roles.size,
      channels: state.channels.size,
    });
  }
}
