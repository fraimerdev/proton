import {
  type ActionExecutor,
  createCommandOptions,
  type EventBus,
  type EventType,
  isScopedActionExecutor,
  type Logger,
  type ModuleRegistry,
  type ProtonEvent,
  type RawOption,
  type Subscription,
} from '@proton/core';
import {
  type CommandRefusal,
  evaluateCommandGate,
  PERMISSIONS_MODULE_ID,
  permissionsConfigSchema,
} from '@proton/module-permissions';
import { ConfigUnavailableError } from './config-provider.ts';
import type { ModulePublisherFactory } from './module-publish.ts';

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
  /**
   * Builds the `publish` a module receives, bound to its id and guild.
   *
   * The command path needs it as much as the listener path does: `/warn` is a
   * command, and `moderation.warned` is what the escalation ladder triggers on.
   */
  publisherFor?: ModulePublisherFactory;
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
 * The invoking member's roles, straight off the interaction.
 *
 * Discord includes `member.roles` on every guild interaction, so the command
 * gate costs no REST call and cannot read a stale cache. An interaction with no
 * member (a DM) yields none, which is correct: a guild override cannot be
 * satisfied outside the guild.
 */
function memberRoleIds(d: Record<string, unknown>): string[] {
  const roles = nested(d.member, 'roles');
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
}

/** Discord sends this as a decimal string; it must not touch Number. */
function appPermissionsOf(d: Record<string, unknown>): bigint | undefined {
  const raw = str(d.app_permissions);
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
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

    // Bind this interaction's context to the executor the module receives.
    // `app_permissions` is Discord's own computation of what the bot may do in
    // this channel (§10.5) — authoritative, free, and immune to a stale cache.
    // `resolved.members` gives target role ids without a REST round trip.
    const base = this.#deps.executor;
    const executor = isScopedActionExecutor(base)
      ? base.scoped({ channelId, appPermissions: appPermissionsOf(d) })
      : base;

    // The guild's command overrides are applied before dispatch, not inside it:
    // an override consulted after the handler ran would be no override at all.
    const refusal = await this.#commandOverrideRefusal(guildId, commandName, memberRoleIds(d));
    if (refusal) {
      await this.#refuse(refusal, {
        guildId,
        userId,
        executor,
        interaction: { id: interactionId, token: interactionToken },
        eventId: event.id,
      });
      return;
    }

    /**
     * A config failure that cannot succeed on retry must not be retried.
     *
     * The same triage the listener path does, for the same reason and against
     * the same error type: rethrowing a 400 leaves the entry unacked, the bus
     * redelivers it five times over a couple of minutes, and then dead-letters
     * an interaction that was never going to work. Having the two runtimes treat
     * one failure differently is exactly the drift `ConfigUnavailableError`
     * exists to prevent.
     */
    let snapshot: ModuleConfigSnapshot;
    try {
      snapshot = await this.#deps.config.get(guildId, manifest.id);
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `/${commandName} could not run because ${manifest.id}'s configuration could not be ` +
            `read, and retrying will not help: ${error.message}. Open the module's settings in ` +
            'the Proton dashboard and save them once to rewrite the stored config.',
          { guildId, moduleId: manifest.id, status: error.status },
        );
        return;
      }
      throw error;
    }

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
      executor,
      logger: this.#deps.logger,
      ...(this.#deps.publisherFor
        ? { publish: this.#deps.publisherFor(manifest.id, guildId) }
        : {}),
      interaction: { id: interactionId, token: interactionToken },
      // The event id is derived deterministically from the dispatch, so a
      // redelivered interaction reuses this key and dedupes (I4).
      idempotencyKey: event.id,
    });
  }

  /**
   * Ask the `permissions` module whether this guild lets this member run this
   * command.
   *
   * The check lives here rather than in a handler because it gates *other*
   * modules' commands, and a module may not reach into another (I3). What the
   * module contributes is its config plus a pure decision function; the runtime
   * owns dispatch, so the runtime owns the gate.
   */
  async #commandOverrideRefusal(
    guildId: string,
    commandName: string,
    roleIds: string[],
  ): Promise<CommandRefusal | null> {
    // Nothing to enforce if the module was never loaded — and asking the API for
    // an unregistered module's config would be an error, not an empty answer.
    if (!this.#deps.registry.get(PERMISSIONS_MODULE_ID)) return null;

    const snapshot = await this.#deps.config.get(guildId, PERMISSIONS_MODULE_ID);
    if (!snapshot.enabled) return null;

    // Validated on every read (I5), as for any other module's config.
    const parsed = permissionsConfigSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      // Fails open, loudly. Refusing every command in the guild because one
      // stored row is unreadable is a far worse outage than an override not
      // applying, and Discord's own command permissions still hold underneath.
      this.#deps.logger.error(
        'invalid stored config for permissions — command overrides are NOT being applied in this guild',
        {
          guildId,
          issues: parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`),
        },
      );
      return null;
    }

    const decision = evaluateCommandGate({
      commandName,
      memberRoleIds: roleIds,
      config: parsed.data,
    });

    return decision.allowed ? null : decision.refusal;
  }

  /**
   * Tell the invoker why the command did not run.
   *
   * Never a silent drop: an unanswered interaction shows "This interaction
   * failed", which teaches nobody anything and reads as an outage (§1, I9). The
   * reply goes through the executor like every other state change (I1).
   */
  async #refuse(
    refusal: CommandRefusal,
    ctx: {
      guildId: string;
      userId: string;
      executor: ActionExecutor;
      interaction: { id: string; token: string };
      /** The event id, which is derived deterministically from the dispatch. */
      eventId: string;
    },
  ): Promise<void> {
    this.#deps.logger.warn(`/${refusal.commandName} refused: ${refusal.code}`, {
      guildId: ctx.guildId,
      userId: ctx.userId,
      requiredRoleIds: refusal.requiredRoleIds,
    });

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: PERMISSIONS_MODULE_ID,
      kind: 'interaction_reply',
      actorId: ctx.userId,
      // Derived from the event id, so a redelivered interaction refuses once;
      // suffixed so it dedupes against this refusal rather than against the
      // reply the handler would otherwise have sent (I4).
      idempotencyKey: `${ctx.eventId}:permission-refusal`,
      dryRun: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        content: refusal.humanReason,
        // Only the invoker needs it, and a public refusal is both noise and an
        // invitation to argue with the bot in the channel.
        ephemeral: true,
      },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      this.#deps.logger.error(
        `could not tell ${ctx.userId} why /${refusal.commandName} was refused: ` +
          `${result.failure?.humanReason ?? 'unknown reason'}`,
        { guildId: ctx.guildId, code: result.failure?.code },
      );
    }
  }
}
