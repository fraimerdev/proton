import type { EventBus, EventType, Logger, Subscription } from '@proton/core';
import type { GuildLayout } from '@proton/module-backup';
import type { Redis } from 'ioredis';

export const GUILD_LAYOUT_PREFIX = 'proton:layout';

export const guildLayoutKey = (guildId: string): string => `${GUILD_LAYOUT_PREFIX}:${guildId}`;

/**
 * The guild's channels and roles as the *gateway* last reported them.
 *
 * Deliberately separate from `GuildStateStore`, which looks like it should serve
 * the same purpose and must not. `GuildState` is a reduction to exactly what the
 * I8 prechecks decide on — role positions, channel overwrites, the owner — and it
 * throws away channel names, types, topics and, fatally, `flags`. Feeding that
 * reduction to the backup module would produce a snapshot in which every
 * obfuscated channel reads as `obfuscated: false` under a `source: 'gateway'`
 * claim, which is a lie the restore planner has no way to catch (§10.1). So this
 * keeps the raw Discord objects verbatim.
 */
/**
 * What a stored layout carries beyond the snapshot itself.
 *
 * `capturedAt` exists to make the delete safe. There is one Redis stream per
 * event type, and `XREADGROUP` returns per-stream batches in key order rather
 * than in timestamp order, so `guild.available` and `guild.unavailable` for the
 * same guild are not guaranteed to arrive in the order they happened — most
 * visibly on a first deploy, when the group replays the retained history of both
 * streams at once. Without a timestamp to compare, a stale "the bot was removed"
 * event replayed after a current "here is the guild" would delete the layout of
 * a server the bot is sitting in, and backups would quietly stop working until
 * the next gateway reconnect.
 */
export interface StoredGuildLayout extends GuildLayout {
  /** `ProtonEvent.occurredAt` of the dispatch this layout came from. */
  capturedAt: number;
}

export interface GuildLayoutStore {
  get(guildId: string): Promise<StoredGuildLayout | null>;
  put(layout: StoredGuildLayout): Promise<void>;
  delete(guildId: string): Promise<void>;
}

export class RedisGuildLayoutStore implements GuildLayoutStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(guildId: string): Promise<StoredGuildLayout | null> {
    const raw = await this.#redis.get(guildLayoutKey(guildId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as StoredGuildLayout;
      // Shape-checked only as far as the caller relies on it; the backup module
      // parses every channel and role defensively on its own account, and
      // duplicating that here would be a second schema to keep in step.
      if (!Array.isArray(parsed.channels) || !Array.isArray(parsed.roles)) return null;
      return parsed;
    } catch {
      // A layout we cannot read is no layout. The caller says "I have no layout
      // for this guild" rather than writing an empty backup, which is the one
      // outcome that must never happen quietly.
      return null;
    }
  }

  async put(layout: StoredGuildLayout): Promise<void> {
    // No TTL. A guild's structure is not a cache with a natural staleness — it is
    // the last thing the gateway told us, and an expired key would mean "no
    // layout" for a guild that is sitting right there, which reads to an admin as
    // backups having silently stopped working.
    await this.#redis.set(guildLayoutKey(layout.guildId), JSON.stringify(layout));
  }

  async delete(guildId: string): Promise<void> {
    await this.#redis.del(guildLayoutKey(guildId));
  }
}

const TYPES: EventType[] = ['guild.available', 'guild.unavailable'];

export interface GuildLayoutConsumerDeps {
  bus: EventBus;
  store: GuildLayoutStore;
  logger: Logger;
  group?: string;
}

/**
 * Records each guild's raw channel and role list from GUILD_CREATE.
 *
 * Its own consumer group, not a second job inside `GuildStateConsumer`, and the
 * separation is the point. `GuildStateConsumer` deliberately fails closed: if the
 * guild cannot be registered in the database it lets the error propagate so the
 * event is redelivered, because caching state for a guild the database does not
 * know about leaves the bot looking healthy and answering nothing. A failure to
 * write a *backup layout* is nowhere near that serious, and must not be able to
 * hold up guild registration. Separate groups mean each acks on its own terms.
 *
 * **Known freshness limit, stated rather than left implicit.** The normaliser
 * emits nothing for CHANNEL_CREATE/UPDATE/DELETE or GUILD_ROLE_*, and the
 * audit-derived `channel.created`/`role.deleted` events carry only ids and an
 * actor — not the objects. So a layout is current as of the last GUILD_CREATE,
 * which the gateway receives on every (re)connect. That is frequent, but it is
 * not continuous: a channel created since the last connect is absent from a
 * backup taken now. Closing this needs those dispatches normalised with their
 * full objects, which is a gateway change, not a backup one.
 */
export class GuildLayoutConsumer {
  readonly #deps: GuildLayoutConsumerDeps;

  constructor(deps: GuildLayoutConsumerDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(this.#deps.group ?? 'guild-layout', TYPES, (event) =>
      this.handle(event),
    );
  }

  async handle(event: {
    type: string;
    guildId: string | null;
    occurredAt: number;
    payload: unknown;
  }): Promise<void> {
    if (!event.guildId) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === 'guild.unavailable') {
      // `unavailable: true` is an outage, and the bot is still a member — the
      // guild is coming back and its layout is still the right answer. Only an
      // actual removal retires it.
      if (payload.unavailable === true) return;

      // And only if this removal is not older than the layout we hold. The two
      // event types live on separate streams and are not read in chronological
      // order, so a replayed "removed" from last week must not delete the layout
      // captured on this morning's reconnect.
      const held = await this.#deps.store.get(event.guildId);
      if (held && held.capturedAt > event.occurredAt) {
        this.#deps.logger.info(
          'ignored a guild-removal event older than the layout already stored for it',
          { guildId: event.guildId },
        );
        return;
      }

      await this.#deps.store.delete(event.guildId);
      return;
    }

    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    const roles = Array.isArray(payload.roles) ? payload.roles : [];

    if (channels.length === 0 && roles.length === 0) {
      // GUILD_CREATE always carries both. Empty means something upstream reduced
      // the payload, which would produce a confidently empty backup.
      this.#deps.logger.warn(
        'guild.available carried no channels or roles, so no backup layout was stored for this ' +
          'server. Backups taken now would be empty.',
        { guildId: event.guildId },
      );
      return;
    }

    /**
     * Stored **verbatim**, and that is the whole design.
     *
     * Every field a restore needs, including the `flags` bit that marks a channel
     * obfuscated (§10.1), survives only because nothing here reshapes the object.
     * Any future "let's just keep the fields we use" optimisation silently
     * downgrades every backup taken afterwards, so the test for this consumer
     * asserts the round trip end to end rather than field by field.
     *
     * `source: 'gateway'` is claimed only here, because only here is it true. The
     * backup module refuses to plan a restore from a REST-sourced layout, since
     * `GET /guilds/{id}/channels` cannot even count the channels it omits.
     */
    // An older GUILD_CREATE replayed after a newer one must not overwrite it.
    const held = await this.#deps.store.get(event.guildId);
    if (held && held.capturedAt > event.occurredAt) return;

    await this.#deps.store.put({
      guildId: event.guildId,
      source: 'gateway',
      capturedAt: event.occurredAt,
      channels,
      roles,
    });

    this.#deps.logger.info('backup layout cached', {
      guildId: event.guildId,
      channels: channels.length,
      roles: roles.length,
    });
  }
}
