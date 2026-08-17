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
  /** Where a refusal points an admin to fix things. */
  dashboardUrl?: string;

  publisherFor?: ModulePublisherFactory;
}

const SUBSCRIBED_TYPES: EventType[] = ['interaction.command'];

export const DEFAULT_DASHBOARD_URL = 'http://localhost:3000';

export type DisabledBy = 'module' | 'config';

/**
 * A guild can switch a module off in two places — the `guild_modules` row and the module's own
 * `enabled` config field — and both read as "off" to a member. Deciding it here means every
 * module gets the same answer instead of each one remembering to check.
 */
export function disabledReason(
  snapshot: ModuleConfigSnapshot,
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
): DisabledBy | null {
  if (!snapshot.enabled) return 'module';

  const parsed = schema.safeParse(snapshot.config);
  const config = parsed.success ? (parsed.data as Record<string, unknown> | undefined) : undefined;

  return config?.enabled === false ? 'config' : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function memberRoleIds(d: Record<string, unknown>): string[] {
  const roles = nested(d.member, 'roles');
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
}

function appPermissionsOf(d: Record<string, unknown>): bigint | undefined {
  const raw = str(d.app_permissions);
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

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

    const base = this.#deps.executor;
    const executor = isScopedActionExecutor(base)
      ? base.scoped({ channelId, appPermissions: appPermissionsOf(d) })
      : base;

    const reply = (content: string, suffix: string, moduleId: string) =>
      this.#tell({
        guildId,
        userId,
        executor,
        interaction: { id: interactionId, token: interactionToken },
        eventId: event.id,
        content,
        suffix,
        moduleId,
      });

    const command = manifest?.commands?.find((c) => c.name === commandName);

    if (!manifest || !command) {
      this.#deps.logger.warn(`no module owns the command '${commandName}'`, { guildId });
      await reply(
        `\`/${commandName}\` is registered with Discord but no Proton module claims it. That ` +
          'usually means the bot was rolled back while the command stayed registered. It will ' +
          'start working again after the next deploy — nothing in this server is broken.',
        'unowned-command',
        PERMISSIONS_MODULE_ID,
      );
      return;
    }

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

    let snapshot: ModuleConfigSnapshot;
    try {
      snapshot = await this.#deps.config.get(guildId, manifest.id);
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `/${commandName} could not run because ${manifest.id}'s configuration could not be ` +
            `read, and retrying will not help: ${error.message}.`,
          { guildId, moduleId: manifest.id, status: error.status },
        );
        await reply(
          `I couldn't read this server's **${manifest.name}** settings, so \`/${commandName}\` ` +
            `did nothing. An admin can repair it by opening ${this.#settingsUrl(guildId, manifest.id)} ` +
            'and pressing Save once, which rewrites the stored settings.',
          'config-unreadable',
          manifest.id,
        );
        return;
      }
      throw error;
    }

    const disabled = disabledReason(snapshot, manifest.configSchema);
    if (disabled) {
      this.#deps.logger.info(`${manifest.id} is disabled in this guild`, { guildId, disabled });
      await reply(
        `**${manifest.name}** is switched off in this server, so \`/${commandName}\` did nothing.\n\n` +
          `A server admin can turn it on at ${this.#settingsUrl(guildId, manifest.id)} — ` +
          `${disabled === 'module' ? 'tick **Module enabled**' : 'tick **Enabled**'} and press Save.`,
        'module-disabled',
        manifest.id,
      );
      return;
    }

    const parsed = manifest.configSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`);
      this.#deps.logger.error(`invalid stored config for ${manifest.id}`, { guildId, issues });
      await reply(
        `This server's **${manifest.name}** settings are not valid, so \`/${commandName}\` did ` +
          `nothing: ${issues.join('; ')}.\n\nAn admin can fix it at ` +
          `${this.#settingsUrl(guildId, manifest.id)}.`,
        'config-invalid',
        manifest.id,
      );
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

      idempotencyKey: event.id,
    });
  }

  #settingsUrl(guildId: string, moduleId: string): string {
    const base = (this.#deps.dashboardUrl ?? DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
    return `<${base}/dashboard/${guildId}/${moduleId}>`;
  }

  async #tell(ctx: {
    guildId: string;
    userId: string;
    executor: ActionExecutor;
    interaction: { id: string; token: string };
    eventId: string;
    content: string;
    suffix: string;
    moduleId: string;
  }): Promise<void> {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: ctx.moduleId,
      kind: 'interaction_reply',
      actorId: ctx.userId,
      idempotencyKey: `${ctx.eventId}:${ctx.suffix}`,
      dryRun: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        content: ctx.content.slice(0, 2000),
        ephemeral: true,
      },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      this.#deps.logger.error(
        `could not tell ${ctx.userId} why the command did not run: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId: ctx.guildId, code: result.failure?.code },
      );
    }
  }

  async #commandOverrideRefusal(
    guildId: string,
    commandName: string,
    roleIds: string[],
  ): Promise<CommandRefusal | null> {
    if (!this.#deps.registry.get(PERMISSIONS_MODULE_ID)) return null;

    const snapshot = await this.#deps.config.get(guildId, PERMISSIONS_MODULE_ID);
    if (!snapshot.enabled) return null;

    const parsed = permissionsConfigSchema.safeParse(snapshot.config);
    if (!parsed.success) {
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

  async #refuse(
    refusal: CommandRefusal,
    ctx: {
      guildId: string;
      userId: string;
      executor: ActionExecutor;
      interaction: { id: string; token: string };

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

      idempotencyKey: `${ctx.eventId}:permission-refusal`,
      dryRun: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        content: refusal.humanReason,

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
