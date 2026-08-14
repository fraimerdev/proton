import {
  type ActionExecutor,
  createCommandOptions,
  type EventBus,
  type EventType,
  type Logger,
  type ModuleRegistry,
  type ProtonEvent,
  type RawOption,
  type Subscription,
} from '@proton/core';

export interface ModuleConfigSnapshot {
  enabled: boolean;
  config: unknown;
}

/**
 * How the worker reads module configuration.
 *
 * A port rather than a database call: PLAN.md §9 requires that the worker and
 * the dashboard share one definition of every domain operation, so the real
 * implementation calls the API service rather than reaching into Postgres and
 * re-implementing validation.
 */
export interface ConfigProvider {
  get(guildId: string, moduleId: string): Promise<ModuleConfigSnapshot>;
}

export interface ModuleRuntimeDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  executor: ActionExecutor;
  config: ConfigProvider;
  logger: Logger;
  group?: string;
}

const SUBSCRIBED_TYPES: EventType[] = ['interaction.command'];

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Consumes normalised events and drives module handlers.
 *
 * A handler that throws propagates, deliberately: the bus leaves the message
 * unacknowledged so it is redelivered, and the executor's idempotency key makes
 * that redelivery harmless. Swallowing errors here would turn an at-least-once
 * bus into an at-most-once one and lose events silently.
 */
export class ModuleRuntime {
  readonly #deps: ModuleRuntimeDeps;

  constructor(deps: ModuleRuntimeDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(this.#deps.group ?? 'worker', SUBSCRIBED_TYPES, (event) =>
      this.handle(event),
    );
  }

  async handle(event: ProtonEvent): Promise<void> {
    if (event.type !== 'interaction.command') return;

    const d = event.payload as Record<string, unknown>;
    const commandName = str(nested(d.data, 'name'));
    const guildId = str(d.guild_id);
    const channelId = str(d.channel_id);
    const interactionId = str(d.id);
    const interactionToken = str(d.token);
    const userId = str(nested(nested(d.member, 'user'), 'id')) ?? str(nested(d.user, 'id'));

    if (!commandName || !guildId || !channelId || !interactionId || !interactionToken || !userId) {
      this.#deps.logger.warn('interaction.command missing required fields', { id: event.id });
      return;
    }

    const manifest = this.#deps.registry
      .all()
      .find((m) => m.commands?.some((c) => c.name === commandName));

    if (!manifest) {
      this.#deps.logger.warn(`no module owns the command '${commandName}'`, { guildId });
      return;
    }

    const command = manifest.commands?.find((c) => c.name === commandName);
    if (!command) return;

    const snapshot = await this.#deps.config.get(guildId, manifest.id);
    if (!snapshot.enabled) {
      this.#deps.logger.info(`${manifest.id} is disabled in this guild`, { guildId });
      return;
    }

    // Validated on every read (I5) — the stored JSONB is never handed to a
    // module unchecked, even though the API validated it on write too.
    const parsed = manifest.configSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      this.#deps.logger.error(`invalid stored config for ${manifest.id}`, {
        guildId,
        issues: parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`),
      });
      return;
    }

    await command.handler({
      guildId,
      channelId,
      userId,
      options: createCommandOptions((nested(d.data, 'options') as RawOption[] | undefined) ?? []),
      config: parsed.data,
      executor: this.#deps.executor,
      logger: this.#deps.logger,
      interaction: { id: interactionId, token: interactionToken },
      // The event id is derived deterministically from the dispatch, so a
      // redelivered interaction reuses this key and dedupes (I4).
      idempotencyKey: event.id,
    });
  }
}
