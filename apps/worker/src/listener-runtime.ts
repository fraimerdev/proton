import type {
  ActionExecutor,
  EventBus,
  EventType,
  Logger,
  ModuleContext,
  ModuleManifest,
  ModuleRegistry,
  ProtonEvent,
  Subscription,
} from '@proton/core';
import { ConfigUnavailableError } from './config-provider.ts';
import { moduleExecutor } from './module-actions.ts';
import type { ModulePublisherFactory } from './module-publish.ts';
import type { ModuleSchedulerFactory } from './module-schedule.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from './runtime.ts';

export const LISTENER_GROUP_PREFIX = 'listener';

export const listenerGroup = (prefix: string, moduleId: string): string => `${prefix}:${moduleId}`;

export interface ListenerRuntimeDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  executor: ActionExecutor;
  config: ConfigProvider;
  logger: Logger;

  groupPrefix?: string;

  publisherFor?: ModulePublisherFactory;
  schedulerFor?: ModuleSchedulerFactory;
}

export function subscribedTypes(manifest: ModuleManifest): EventType[] {
  return [...new Set((manifest.listeners ?? []).flatMap((listener) => listener.types))];
}

export class ModuleListenerRuntime {
  readonly #deps: ListenerRuntimeDeps;
  readonly #prefix: string;

  constructor(deps: ListenerRuntimeDeps) {
    this.#deps = deps;
    this.#prefix = deps.groupPrefix ?? LISTENER_GROUP_PREFIX;
  }

  listening(): ModuleManifest[] {
    return this.#deps.registry.all().filter((manifest) => subscribedTypes(manifest).length > 0);
  }

  start(): Subscription[] {
    return this.listening().map((manifest) => {
      const types = subscribedTypes(manifest);

      this.#deps.logger.info(`listening for ${manifest.id}`, {
        moduleId: manifest.id,
        types: types.join(', '),
      });

      return this.#deps.bus.subscribe(
        listenerGroup(this.#prefix, manifest.id),
        types,
        (event) => this.handleFor(manifest, event),
        // '$' on group creation only: '0' would replay all history and re-execute settled events.
        { startId: '$' },
      );
    });
  }

  async handleFor(manifest: ModuleManifest, event: ProtonEvent): Promise<void> {
    if (event.guildId === null) {
      return;
    }
    const guildId = event.guildId;

    const matching = (manifest.listeners ?? []).filter((listener) =>
      listener.types.includes(event.type),
    );
    if (matching.length === 0) return;

    const snapshot = await this.#snapshot(guildId, manifest, event);
    if (snapshot === null) return;

    // A module that has just been switched off still gets its own config_changed, so it can undo
    // what it owns outside Proton. Automod's Discord AutoMod rules would otherwise keep blocking
    // messages after the admin turned the module off, with nothing left running to remove them.
    if (!snapshot.enabled && event.type !== 'proton.config_changed') return;

    const parsed = manifest.configSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      this.#deps.logger.error(`invalid stored config for ${manifest.id}, so it did not run`, {
        guildId,
        moduleId: manifest.id,
        eventType: event.type,
        issues: parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`),
      });
      return;
    }

    const ctx: ModuleContext<typeof parsed.data> = {
      guildId,
      config: parsed.data,
      tier: snapshot.tier ?? 'free',
      executor: moduleExecutor(this.#deps.registry, manifest.id, this.#deps.executor),
      logger: this.#deps.logger,

      ...(this.#deps.publisherFor
        ? { publish: this.#deps.publisherFor(manifest.id, guildId) }
        : {}),
      ...(this.#deps.schedulerFor ? this.#deps.schedulerFor(manifest.id, guildId) : {}),
    };

    for (const listener of matching) {
      await listener.handler(event, ctx);
    }
  }

  async #snapshot(
    guildId: string,
    manifest: ModuleManifest,
    event: ProtonEvent,
  ): Promise<ModuleConfigSnapshot | null> {
    try {
      return await this.#deps.config.get(guildId, manifest.id);
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `${manifest.id} did not run in this server because its configuration could not be ` +
            `read, and retrying will not help: ${error.message}. Open the module's settings in ` +
            'the Proton dashboard and save them once to rewrite the stored config.',
          {
            guildId,
            moduleId: manifest.id,
            status: error.status,
            eventType: event.type,
            eventId: event.id,
          },
        );
        return null;
      }
      throw error;
    }
  }
}
