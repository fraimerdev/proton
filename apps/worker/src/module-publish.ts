import type { EventBus, EventType, Logger, ModuleRegistry } from '@proton/core';

/**
 * The event id a module-published event gets.
 *
 * Same shape as the gateway's `deriveEventId` — `<type>:<natural key>` — and
 * deliberately so: every consumer downstream treats an id as an opaque dedupe
 * key, and having two formats in the system would make an id's origin readable
 * from its shape, which invites someone to parse it.
 *
 * The guild is folded in because a module supplies only its own natural key, and
 * two guilds warning the same user id in the same second would otherwise collide
 * — one guild's escalation ladder silently swallowing the other's warning.
 */
export function moduleEventId(type: EventType, guildId: string, naturalKey: string): string {
  return `${type}:${guildId}:${naturalKey}`;
}

export class UndeclaredEventError extends Error {
  constructor(moduleId: string, type: EventType) {
    super(
      `The '${moduleId}' module tried to publish '${type}', which it does not declare in its ` +
        "manifest's `emits` array. Add it there if the module should be able to publish it — " +
        "the allowlist is what stops one module forging another module's events.",
    );
    this.name = 'UndeclaredEventError';
  }
}

export interface ModulePublisherDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  logger: Logger;
  /** Overridable so a test can pin `occurredAt` instead of inheriting the clock. */
  now?: () => number;
}

/**
 * Build the `publish` function a module receives on its `ModuleContext`.
 *
 * This is the whole of the opening in I3, and it is worth being precise about
 * what it does and does not concede. A module still holds no `EventBus`: it gets
 * a closure bound to its own id and one guild, and three things are decided out
 * here rather than by the caller.
 *
 *  1. **The type is checked against the manifest's allowlist.** Without this,
 *     `leveling` could publish `moderation.warned` and drive another module's
 *     escalation ladder into timing people out — and nothing downstream could
 *     tell the forged event from a real one, because they are the same shape by
 *     construction.
 *  2. **The guild is stamped from the context**, so a module cannot publish into
 *     a guild it was not invoked for.
 *  3. **The id is derived, not supplied.** A module passes a natural key and
 *     gets a deterministic id, so a redelivered cause produces a redelivered
 *     effect with the same id and the executor dedupes it (I4). Letting a module
 *     mint its own id would let it defeat that by accident — `newId()` looks
 *     like the obvious thing to reach for and would be wrong every time.
 *
 * An undeclared type throws rather than logging and continuing. It is a
 * programming error, not a runtime condition: the manifest and the call have
 * disagreed, no config can change that, and the module's own tests should be the
 * thing that finds it.
 */
export function createModulePublisher(deps: ModulePublisherDeps) {
  const now = deps.now ?? (() => Date.now());

  return function publisherFor(moduleId: string, guildId: string) {
    return async function publish(
      type: EventType,
      naturalKey: string,
      payload: unknown,
    ): Promise<void> {
      if (!deps.registry.mayEmit(moduleId, type)) {
        throw new UndeclaredEventError(moduleId, type);
      }

      const event = {
        id: moduleEventId(type, guildId, naturalKey),
        type,
        guildId,
        occurredAt: now(),
        payload,
      };

      deps.logger.info(`${moduleId} published ${type}`, {
        guildId,
        moduleId,
        eventId: event.id,
      });

      await deps.bus.publish(event);
    };
  };
}

export type ModulePublisherFactory = ReturnType<typeof createModulePublisher>;
