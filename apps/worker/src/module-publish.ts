import type { EventBus, EventType, Logger, ModuleRegistry } from '@proton/core';

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

  now?: () => number;
}

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
