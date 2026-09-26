import {
  type ActionExecutor,
  type CommandSettings,
  type CommandWorkerView,
  type ContextMenuType,
  contextMenuKey,
  createCommandOptions,
  DEFAULT_COMMAND_SETTINGS,
  type EntitlementTier,
  type EventBus,
  type EventType,
  errorStatus,
  formatCommandLabel,
  isScopedActionExecutor,
  type Logger,
  type ModuleManifest,
  type ModuleRegistry,
  type ProtonEvent,
  type RawOption,
  readResolved,
  resolvePrivateReply,
  type Subscription,
  subcommandPath,
} from '@proton/core';
import {
  type CommandRefusal,
  evaluateCommandGate,
  PERMISSIONS_MODULE_ID,
  permissionsConfigSchema,
} from '@proton/module-permissions';
import { ApplicationCommandType } from 'discord-api-types/v10';
import type { CommandLabelSource } from './command-labels.ts';
import { type CommandResolverPort, outdatedRefusal, UPDATING_REFUSAL } from './command-resolver.ts';
import { ConfigUnavailableError } from './config-provider.ts';
import { loggableError } from './error-log.ts';
import { watchAcknowledgement } from './interaction-ack.ts';
import { moduleExecutor } from './module-actions.ts';
import type { ModulePublisherFactory } from './module-publish.ts';
import type { ModuleSchedulerFactory } from './module-schedule.ts';

export interface ModuleConfigSnapshot {
  enabled: boolean;
  config: unknown;
  // Optional so a provider that predates the field still satisfies the port.
  schemaVersion?: number;

  tier?: EntitlementTier;
}

export interface ConfigProvider {
  get(guildId: string, moduleId: string): Promise<ModuleConfigSnapshot>;
  invalidate?(guildId: string, moduleId: string): void;
}

export interface ModuleRuntimeDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  executor: ActionExecutor;
  config: ConfigProvider;
  logger: Logger;
  group?: string;
  dashboardUrl?: string;

  publisherFor?: ModulePublisherFactory;
  schedulerFor?: ModuleSchedulerFactory;

  resolver?: CommandResolverPort;
  commandSettings?: { get(guildId: string): Promise<CommandWorkerView> };
  labels?: CommandLabelSource;
  refused?: { has(key: string): Promise<boolean> };
}

const SUBSCRIBED_TYPES: EventType[] = ['interaction.command'];

const UPDATING_SUFFIX = 'commands-updating';

export const DEFAULT_DASHBOARD_URL = 'http://localhost:3000';

export type DisabledBy = 'module' | 'config';

// The guild_modules row and the module's own enabled field both switch a module off.
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

// member.permissions, not app_permissions: the invoker's authorise the request, the bot's do not.
function memberPermissionsOf(d: Record<string, unknown>): bigint | undefined {
  const raw = str(nested(d.member, 'permissions'));
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

function memberNickOf(d: Record<string, unknown>): string | null | undefined {
  if (typeof d.member !== 'object' || d.member === null) return undefined;
  const nick = nested(d.member, 'nick');
  if (nick === null) return null;
  return typeof nick === 'string' ? nick : undefined;
}

function memberJoinedAtOf(d: Record<string, unknown>): number | null {
  const raw = str(nested(d.member, 'joined_at'));
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

function displayNameOf(d: Record<string, unknown>): string | undefined {
  const user = nested(d.member, 'user') ?? d.user;
  return str(nested(user, 'global_name')) ?? str(nested(user, 'username')) ?? undefined;
}

function contextMenuTypeOf(d: Record<string, unknown>): ContextMenuType | null {
  const type = nested(d.data, 'type');
  if (type === ApplicationCommandType.User) return 'user';
  if (type === ApplicationCommandType.Message) return 'message';
  return null;
}

function noSettingsPage(moduleName: string): string {
  return `**${moduleName}** has no settings page to fix them from, so the problem is on my end.`;
}

export class ModuleRuntime {
  readonly #deps: ModuleRuntimeDeps;
  #settingsFailing = false;

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
    const invokedName = str(nested(d.data, 'name'));
    const guildId = str(d.guild_id);
    const channelId = str(d.channel_id);
    const interactionId = str(d.id);
    const interactionToken = str(d.token);
    const userId = str(nested(nested(d.member, 'user'), 'id')) ?? str(nested(d.user, 'id'));
    const menuType = contextMenuTypeOf(d);
    const targetId = str(nested(d.data, 'target_id'));

    if (
      !invokedName ||
      !guildId ||
      !channelId ||
      !interactionId ||
      !interactionToken ||
      !userId ||
      (menuType && !targetId)
    ) {
      this.#deps.logger.warn('interaction.command missing required fields', { id: event.id });
      return;
    }

    const base = this.#deps.executor;
    const executor = isScopedActionExecutor(base)
      ? base.scoped({ channelId, appPermissions: appPermissionsOf(d) })
      : base;

    const reply = (
      content: string,
      suffix: string,
      moduleId: string,
      followUp?: { applicationId: string; ephemeral: boolean },
    ) =>
      this.#tell({
        guildId,
        userId,
        executor,
        interaction: { id: interactionId, token: interactionToken },
        eventId: event.id,
        content,
        suffix,
        moduleId,
        ...(followUp ?? {}),
      });

    if (await this.#deps.refused?.has(`${event.id}:${UPDATING_SUFFIX}`)) {
      this.#deps.logger.info(
        `a redelivered ${menuType ? invokedName : `/${invokedName}`} was already refused while ` +
          "this server's commands were updating, so it was not run",
        { guildId, id: event.id },
      );
      return;
    }

    const resolution = this.#deps.resolver
      ? await this.#deps.resolver.resolve(guildId, d)
      : {
          key: menuType ? contextMenuKey(menuType, invokedName) : invokedName,
          displayName: invokedName,
        };

    if ('unresolved' in resolution) {
      if (resolution.unresolved === 'outdated') {
        await reply(
          outdatedRefusal(invokedName, resolution.current, this.#commandsLink(guildId)),
          'command-outdated',
          PERMISSIONS_MODULE_ID,
        );
      } else {
        await reply(UPDATING_REFUSAL, UPDATING_SUFFIX, PERMISSIONS_MODULE_ID);
      }
      return;
    }

    const { key, displayName } = resolution;
    const label = menuType ? `Apps → ${displayName}` : `/${displayName}`;

    const manifest = this.#deps.registry
      .all()
      .find((m) =>
        menuType
          ? m.contextMenus?.some((c) => contextMenuKey(c.type, c.name) === key)
          : m.commands?.some((c) => c.name === key),
      );

    const command = menuType ? undefined : manifest?.commands?.find((c) => c.name === key);
    const menu = menuType
      ? manifest?.contextMenus?.find((c) => contextMenuKey(c.type, c.name) === key)
      : undefined;

    if (!manifest || (!command && !menu)) {
      this.#deps.logger.warn(`no module owns the command '${label}'`, { guildId });
      await reply(
        `\`${label}\` isn't working right now. The problem is on my end, not in this server's ` +
          'settings.',
        'unowned-command',
        PERMISSIONS_MODULE_ID,
      );
      return;
    }

    const [refusal, read, settings, labels] = await Promise.all([
      // Context menus are not in the permissions module's overrides, which key on slash names.
      command
        ? this.#commandOverrideRefusal(guildId, key, displayName, memberRoleIds(d))
        : Promise.resolve(null),
      this.#deps.config.get(guildId, manifest.id).then(
        (value) => ({ snapshot: value, error: undefined }),
        (error: unknown) => ({ snapshot: undefined, error }),
      ),
      this.#settingsFor(guildId, key),
      this.#deps.labels?.forGuild(guildId),
    ]);

    if (!settings.enabled) {
      this.#deps.logger.info(`${label} is switched off in this guild`, { guildId, key });
      await reply(
        `\`${label}\` is off in this server. A server admin can turn it on at ` +
          `${this.#commandsLink(guildId)}.`,
        'command-switched-off',
        manifest.id,
      );
      return;
    }

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
    if (read.snapshot) {
      snapshot = read.snapshot;
    } else {
      const error = read.error;
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `${label} could not run because ${manifest.id}'s configuration could not be ` +
            `read, and retrying will not help: ${error.message}.`,
          { guildId, moduleId: manifest.id, status: error.status },
        );
        await reply(
          `I couldn't read this server's **${manifest.name}** settings, so \`${label}\` ` +
            "didn't run. The problem is on my end, not in anything an admin changed.",
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
      const where = manifest.dashboard
        ? 'the switch at the top of the page'
        : `the switch on the **${manifest.name}** card`;
      await reply(
        `**${manifest.name}** is off in this server, so \`${label}\` can't run. A server admin ` +
          `can turn it on at ${this.#dashboardLink(guildId, manifest)} using ${where}.`,
        'module-disabled',
        manifest.id,
      );
      return;
    }

    const parsed = manifest.configSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`);
      this.#deps.logger.error(`invalid stored config for ${manifest.id}`, { guildId, issues });
      const fix = manifest.dashboard
        ? `A server admin can fix them at ${this.#dashboardLink(guildId, manifest)}.`
        : noSettingsPage(manifest.name);
      await reply(
        `This server's **${manifest.name}** settings aren't valid, so \`${label}\` didn't ` +
          `run: ${issues.join('; ')}.\n\n${fix}`,
        'config-invalid',
        manifest.id,
      );
      return;
    }

    const actorPermissions = memberPermissionsOf(d);
    const actorNick = memberNickOf(d);
    const actorDisplayName = displayNameOf(d);
    const resolved = readResolved(d);
    const applicationId = str(d.application_id);
    const raw = (nested(d.data, 'options') as RawOption[] | undefined) ?? [];
    const privateReply = command?.reply
      ? resolvePrivateReply(command.reply, parsed.data, subcommandPath(raw), settings.privateReply)
      : undefined;

    // Not the refusals' executor: those run as permissions for a module that declared nothing.
    const watch = watchAcknowledgement(moduleExecutor(this.#deps.registry, manifest.id, executor), {
      id: interactionId,
      token: interactionToken,
    });

    const ctx = {
      guildId,
      channelId,
      userId,
      actorRoleIds: memberRoleIds(d),
      ...(actorPermissions === undefined ? {} : { actorPermissions }),
      ...(actorNick === undefined ? {} : { actorNick }),
      ...(actorDisplayName === undefined ? {} : { actorDisplayName }),
      actorJoinedAt: memberJoinedAtOf(d),
      resolved,
      config: parsed.data,
      tier: snapshot.tier ?? 'free',
      executor: watch.executor,
      logger: this.#deps.logger,
      ...(this.#deps.publisherFor
        ? { publish: this.#deps.publisherFor(manifest.id, guildId) }
        : {}),
      ...(this.#deps.schedulerFor ? this.#deps.schedulerFor(manifest.id, guildId) : {}),
      ...(labels
        ? {
            commandLabel: (labelKey: string, path?: string) =>
              labelKey === key
                ? formatCommandLabel(labelKey, path, displayName)
                : labels(labelKey, path),
          }
        : {}),
      interaction: { id: interactionId, token: interactionToken },
      ...(applicationId ? { applicationId } : {}),
      ...(privateReply === undefined ? {} : { privateReply }),

      idempotencyKey: event.id,
    };

    try {
      if (menu && menuType && targetId) {
        await menu.handler({ ...ctx, commandType: menuType, targetId });
      } else if (command) {
        await command.handler({ ...ctx, options: createCommandOptions(raw, resolved) });
      }
    } catch (error) {
      const thrown = loggableError(error);
      const acknowledged = watch.acknowledged();
      this.#deps.logger.error(
        `${label} threw ${
          acknowledged
            ? 'after it had answered'
            : `before ${manifest.id} answered anything of its own`
        }: ${thrown.stack ?? thrown.message}`,
        { guildId, moduleId: manifest.id, userId },
      );

      const apology =
        `Something went wrong with \`${label}\`, so it may not have finished. Try again in a ` +
        'moment.';

      // A second initial callback is refused by Discord and leaves the member on "thinking…".
      if (!acknowledged) {
        await reply(apology, 'handler-threw', manifest.id);
      } else if (applicationId) {
        // Discord gives the first followup after a defer the defer's visibility, whatever it asks.
        if (watch.publicDeferOpen()) {
          await reply(`\`${label}\` didn't go through.`, 'handler-threw-public', manifest.id, {
            applicationId,
            ephemeral: false,
          });
        }
        await reply(apology, 'handler-threw', manifest.id, { applicationId, ephemeral: true });
      } else {
        this.#deps.logger.error(
          `${label} had already answered ${userId}, and the interaction carried no application ` +
            'id to follow up with, so they were not told it failed',
          { guildId, moduleId: manifest.id, userId },
        );
      }

      // Rethrown so the bus retries; every answer is keyed on the event id, so a redelivery dedupes.
      throw error;
    }
  }

  // No dashboard sections means no settings page: the module is only a switch on the overview.
  #dashboardLink(guildId: string, manifest: ModuleManifest): string {
    const base = (this.#deps.dashboardUrl ?? DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
    return manifest.dashboard
      ? `<${base}/dashboard/${guildId}/${manifest.id}>`
      : `<${base}/dashboard/${guildId}>`;
  }

  #commandsLink(guildId: string): string {
    const base = (this.#deps.dashboardUrl ?? DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
    return `<${base}/dashboard/${guildId}/commands>`;
  }

  async #settingsFor(guildId: string, key: string): Promise<CommandSettings> {
    const source = this.#deps.commandSettings;
    if (!source) return DEFAULT_COMMAND_SETTINGS;

    try {
      const view = await source.get(guildId);
      this.#settingsFailing = false;
      return (
        (Object.hasOwn(view.settings, key) ? view.settings[key] : undefined) ??
        DEFAULT_COMMAND_SETTINGS
      );
    } catch (error) {
      if (!this.#settingsFailing) {
        this.#settingsFailing = true;
        this.#deps.logger.warn(
          'could not read the per-server command settings, so commands run as switched on with ' +
            `their default reply visibility until they can be read again: ${
              error instanceof Error ? error.message : String(error)
            }`,
          { guildId },
        );
      }
      return DEFAULT_COMMAND_SETTINGS;
    }
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
    applicationId?: string;
    ephemeral?: boolean;
  }): Promise<void> {
    const message = {
      interactionToken: ctx.interaction.token,
      ...errorStatus(ctx.content),
      ephemeral: ctx.ephemeral ?? true,
    };

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: ctx.moduleId,
      actorId: ctx.userId,
      idempotencyKey: `${ctx.eventId}:${ctx.suffix}`,
      dryRun: false,
      ...(ctx.applicationId
        ? {
            kind: 'interaction_followup' as const,
            payload: { applicationId: ctx.applicationId, ...message },
          }
        : {
            kind: 'interaction_reply' as const,
            payload: { interactionId: ctx.interaction.id, ...message },
          }),
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
    displayName: string,
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
      displayName,
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
        ...errorStatus(refusal.humanReason),

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
