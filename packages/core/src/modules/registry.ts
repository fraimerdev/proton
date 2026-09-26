import { ApplicationCommandType, GatewayIntentBits } from 'discord-api-types/v10';
import { type ActionKind, REQUIRED_PERMISSIONS } from '../actions/kinds.ts';
import { validateCommand } from '../commands/effective.ts';
import { leafPaths } from '../commands/fields.ts';
import { type FieldDescriptor, zodToDescriptors } from '../config/descriptor.ts';
import type { EventType } from '../events/types.ts';
import { combinePermissions, missing, Permissions, permissionLabels } from '../permissions/bits.ts';
import type { AvailableProvider } from '../providers/registry.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import type { ModuleAvailability } from '../providers/types.ts';
import type { SimulationAdapter } from '../simulation/types.ts';
import type { ContextMenuType, ModuleManifest } from './manifest.ts';

export type DisabledCode =
  | 'missing_intent'
  | 'missing_permission'
  | 'missing_dependency'
  | 'insufficient_entitlement';

export interface ModuleStatus {
  id: string;
  enabled: boolean;
  disabledReason?: { code: DisabledCode; humanReason: string };
}

export interface RegistryEnvironment {
  grantedIntents: number;

  botPermissions: bigint;
  tier?: 'free' | 'plus' | 'pro';
}

const TIER_RANK: Record<'free' | 'plus' | 'pro', number> = { free: 0, plus: 1, pro: 2 };

const CONDITIONAL_PERMISSIONS: Record<ActionKind, bigint> = {
  send:
    Permissions.SendPolls |
    Permissions.EmbedLinks |
    Permissions.AttachFiles |
    Permissions.ReadMessageHistory,
  edit_message: 0n,
  delete_message: 0n,
  add_reaction: 0n,
  remove_reaction: 0n,
  interaction_reply: 0n,
  interaction_followup: 0n,
  interaction_edit_original: 0n,
  warn: 0n,
  unwarn: 0n,
  ban: 0n,
  unban: 0n,
  kick: 0n,
  timeout: 0n,
  untimeout: 0n,
  add_role: 0n,
  remove_role: 0n,
  purge: 0n,
  slowmode: 0n,
  lockdown: 0n,
  unlock: 0n,
  create_channel: Permissions.ManageRoles,
  create_role: 0n,
  delete_role: 0n,
  delete_channel: 0n,
  edit_channel: Permissions.ManageRoles,
  set_channel_overwrite: 0n,
  delete_channel_overwrite: 0n,
  create_thread: Permissions.CreatePublicThreads | Permissions.CreatePrivateThreads,
  move_member: 0n,
  set_member_nickname: 0n,
  end_poll: 0n,
  pin_message: 0n,
  automod_rule_create: 0n,
  automod_rule_update: 0n,
  automod_rule_delete: 0n,
  giveaway_draw: 0n,
  create_dm: 0n,
  set_bot_nickname: 0n,
  set_bot_profile: 0n,
  set_bot_name_style: 0n,
};

// Not requiredPermissionsFor(kind, payload): a rung carries no channelId until the engine merges
// payloadDefaults in at fire time, so parsing one here drops SendPolls and inverts the thread bits.
export function invitePermissionsFor(kind: ActionKind): bigint {
  return REQUIRED_PERMISSIONS[kind] | CONDITIONAL_PERMISSIONS[kind];
}

function ruleActionPermissions(manifest: ModuleManifest): bigint {
  const rules = [
    ...(manifest.rules ?? []),
    ...(manifest.compileRules?.(manifest.defaultConfig) ?? []),
  ];

  return combinePermissions(
    rules.flatMap((rule) => rule.actions.map((a) => invitePermissionsFor(a.kind))),
  );
}

// The developer portal lists the three privileged intents under names of its own. An admin sent
// there looking for "GuildMembers" finds nothing called that on the page.
const INTENT_LABELS: Record<string, string> = {
  GuildMembers: 'Server Members Intent',
  MessageContent: 'Message Content Intent',
  GuildPresences: 'Presence Intent',
};

const PRIVILEGED_INTENTS =
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.MessageContent |
  GatewayIntentBits.GuildPresences;

// By bit, not by name: GuildBans is a deprecated alias sharing GuildModeration's value, so listing
// names would tell an admin two intents are missing when one is.
function intentLabels(bits: number): string[] {
  const byBit = new Map<number, string>();

  for (const [name, value] of Object.entries(GatewayIntentBits) as Array<[string, number]>) {
    if (value === 0 || (bits & value) !== value) continue;
    if (INTENT_LABELS[name] || !byBit.has(value)) {
      byBit.set(value, INTENT_LABELS[name] ?? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
    }
  }

  return [...byBit.values()];
}

export class ModuleRegistrationError extends Error {
  constructor(moduleId: string, detail: string) {
    super(`Module '${moduleId}' is invalid: ${detail}`);
    this.name = 'ModuleRegistrationError';
  }
}

export class UndeclaredScheduleError extends Error {
  constructor(moduleId: string, jobId: string, detail: string) {
    super(
      `The '${moduleId}' module and the durable schedule '${jobId}' do not line up: ${detail} ` +
        "Every id in a manifest's `schedules` array needs a matching `scheduledHandlers` entry, " +
        'and nothing outside that list can be scheduled — the allowlist is what keeps this a ' +
        'port instead of handing a module the scheduled_actions table.',
    );
    this.name = 'UndeclaredScheduleError';
  }
}

export interface ModuleRegistryOptions {
  // Passed in rather than owned when a module needs the registry at construction time: the
  // giveaway consumes providers other modules register, so one instance has to exist first.
  providers?: ProviderRegistry;
}

export const MAX_CONTEXT_MENUS_PER_TYPE = 15;

export const MAX_CHAT_COMMANDS = 100;

export const MAX_INTERACTION_CONCURRENCY = 16;

const CONTEXT_MENU_COMMAND_TYPES: Record<ContextMenuType, ApplicationCommandType> = {
  user: ApplicationCommandType.User,
  message: ApplicationCommandType.Message,
};

function assertContextMenusValid(
  manifest: ModuleManifest,
  registered: readonly ModuleManifest[],
): void {
  const menus = manifest.contextMenus ?? [];
  if (menus.length === 0) return;

  for (const menu of menus) {
    if (menu.data.name !== menu.name || menu.data.type !== CONTEXT_MENU_COMMAND_TYPES[menu.type]) {
      throw new ModuleRegistrationError(
        manifest.id,
        `the ${menu.type} context menu '${menu.name}' registers data for a different name or type`,
      );
    }
  }

  const everywhere = [...registered, manifest].flatMap((owner) =>
    (owner.contextMenus ?? []).map((menu) => ({ owner: owner.id, menu })),
  );

  for (const type of ['user', 'message'] as const) {
    const ofType = everywhere.filter(({ menu }) => menu.type === type);

    for (const menu of menus.filter((candidate) => candidate.type === type)) {
      const holders = ofType.filter(
        ({ menu: other }) => other.name.toLowerCase() === menu.name.toLowerCase(),
      );
      if (holders.length > 1) {
        const elsewhere = holders.find(({ owner }) => owner !== manifest.id);
        throw new ModuleRegistrationError(
          manifest.id,
          `the ${type} context menu '${menu.name}' is ${
            elsewhere ? `already declared by '${elsewhere.owner}'` : 'declared twice'
          }`,
        );
      }
    }

    if (ofType.length > MAX_CONTEXT_MENUS_PER_TYPE) {
      throw new ModuleRegistrationError(
        manifest.id,
        `it brings Proton to ${ofType.length} ${type} context menus, and Discord allows ` +
          `${MAX_CONTEXT_MENUS_PER_TYPE}`,
      );
    }
  }
}

function describeLeaves(leaves: readonly string[]): string {
  return leaves.length === 1 && leaves[0] === ''
    ? 'it has no subcommands, so the only path is an empty string'
    : `its subcommands are ${leaves.join(', ')}`;
}

function assertCommandsValid(
  manifest: ModuleManifest,
  registered: readonly ModuleManifest[],
): void {
  const commands = manifest.commands ?? [];
  if (commands.length === 0) return;

  for (const command of commands) {
    if (command.data.name !== command.name) {
      throw new ModuleRegistrationError(
        manifest.id,
        `the command '/${command.name}' registers data named '${command.data.name}'`,
      );
    }

    const issues = validateCommand(command.data);
    if (issues.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `Discord would refuse /${command.name}: ${issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join(' ')}`,
      );
    }

    const leaves = leafPaths(command.data);
    const stray = (command.reply?.toggleable ?? []).filter((path) => !leaves.includes(path));
    if (stray.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `/${command.name} lets admins choose the reply visibility of ${stray
          .map((path) => `'${path}'`)
          .join(', ')}, which ${stray.length === 1 ? 'is' : 'are'} not a subcommand path of it — ` +
          describeLeaves(leaves),
      );
    }
  }

  const everywhere = [...registered, manifest].flatMap((owner) =>
    (owner.commands ?? []).map((command) => ({ owner: owner.id, command })),
  );

  for (const command of commands) {
    const holders = everywhere.filter(({ command: other }) => other.name === command.name);
    if (holders.length > 1) {
      const elsewhere = holders.find(({ owner }) => owner !== manifest.id);
      throw new ModuleRegistrationError(
        manifest.id,
        `the command '/${command.name}' is ${
          elsewhere ? `already declared by '${elsewhere.owner}'` : 'declared twice'
        }`,
      );
    }
  }

  if (everywhere.length > MAX_CHAT_COMMANDS) {
    throw new ModuleRegistrationError(
      manifest.id,
      `it brings Proton to ${everywhere.length} slash commands, and Discord allows ` +
        `${MAX_CHAT_COMMANDS} per server`,
    );
  }
}

function assertSimulationsValid(manifest: ModuleManifest): void {
  const simulations = manifest.simulations ?? [];
  if (simulations.length === 0) return;

  const seen = new Set<string>();
  const surfaces = manifest.templates?.surfaces ?? {};

  for (const { descriptor } of simulations) {
    const where = `simulation '${descriptor.id}'`;

    if (seen.has(descriptor.id)) {
      throw new ModuleRegistrationError(manifest.id, `${where} is declared twice`);
    }
    seen.add(descriptor.id);

    if (descriptor.moduleId !== manifest.id) {
      throw new ModuleRegistrationError(
        manifest.id,
        `${where} says it belongs to '${descriptor.moduleId}'`,
      );
    }

    // The point of the whole feature is that a rehearsal renders through the surface a real event
    // renders through. A simulation naming a surface this module does not register would be
    // rehearsing something else.
    if (descriptor.surfaceId !== undefined && !Object.hasOwn(surfaces, descriptor.surfaceId)) {
      throw new ModuleRegistrationError(
        manifest.id,
        `${where} renders '${descriptor.surfaceId}', which this module's templates do not declare`,
      );
    }

    if (descriptor.delivery === 'channel' && descriptor.output !== 'message') {
      throw new ModuleRegistrationError(
        manifest.id,
        `${where} delivers to a channel but does not produce a message`,
      );
    }

    const keys = descriptor.inputs.map(({ key }) => key);
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
    if (repeated.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `${where} declares the input ${[...new Set(repeated)].join(', ')} more than once`,
      );
    }
  }
}

export class ModuleRegistry {
  readonly #modules = new Map<string, ModuleManifest>();
  readonly #descriptors = new Map<string, FieldDescriptor[]>();
  readonly #providers: ProviderRegistry;

  constructor(options: ModuleRegistryOptions = {}) {
    this.#providers = options.providers ?? new ProviderRegistry();
  }

  register(manifest: ModuleManifest): void {
    if (this.#modules.has(manifest.id)) {
      throw new ModuleRegistrationError(manifest.id, 'a module with this id is already registered');
    }

    const parsed = manifest.configSchema.safeParse(manifest.defaultConfig);
    if (!parsed.success) {
      throw new ModuleRegistrationError(
        manifest.id,
        `defaultConfig does not satisfy configSchema: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    if (manifest.formSchema) {
      const configKeys = new Set(Object.keys(manifest.configSchema.shape));
      const stray = Object.keys(manifest.formSchema.shape).filter((k) => !configKeys.has(k));
      if (stray.length > 0) {
        throw new ModuleRegistrationError(
          manifest.id,
          `formSchema declares ${stray.join(', ')}, which ${
            stray.length === 1 ? 'is' : 'are'
          } not in configSchema`,
        );
      }
    }

    const emits = manifest.emits ?? [];
    const duplicated = emits.filter((type, index) => emits.indexOf(type) !== index);
    if (duplicated.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `emits lists ${[...new Set(duplicated)].join(', ')} more than once`,
      );
    }

    const kinds = manifest.actionKinds ?? [];
    const restated = kinds.filter((kind, index) => kinds.indexOf(kind) !== index);
    if (restated.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `actionKinds lists ${[...new Set(restated)].join(', ')} more than once`,
      );
    }

    const schedules = manifest.schedules ?? [];
    const repeated = schedules.filter((id, index) => schedules.indexOf(id) !== index);
    if (repeated.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `schedules lists ${[...new Set(repeated)].join(', ')} more than once`,
      );
    }

    const handlers = manifest.scheduledHandlers ?? {};

    for (const jobId of Object.keys(handlers)) {
      if (!schedules.includes(jobId)) {
        throw new UndeclaredScheduleError(
          manifest.id,
          jobId,
          'it has a handler for it but does not declare it in `schedules`.',
        );
      }
    }

    for (const jobId of schedules) {
      // Object.hasOwn first: handlers['constructor'] is Object, which a plain lookup would accept.
      const handler = Object.hasOwn(handlers, jobId) ? handlers[jobId] : undefined;

      if (typeof handler !== 'function') {
        throw new UndeclaredScheduleError(
          manifest.id,
          jobId,
          'it declares the id but has no handler for it, so anything scheduled under it would ' +
            'sit in the table until it was abandoned.',
        );
      }
    }

    for (const jobId of manifest.scheduledWhileDisabled ?? []) {
      if (!schedules.includes(jobId)) {
        throw new UndeclaredScheduleError(
          manifest.id,
          jobId,
          'it lets the id run while the module is off but does not declare it in `schedules`.',
        );
      }
    }

    const concurrency = manifest.interactionConcurrency;
    if (
      concurrency !== undefined &&
      (!Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > MAX_INTERACTION_CONCURRENCY)
    ) {
      throw new ModuleRegistrationError(
        manifest.id,
        `interactionConcurrency is ${concurrency}, and it must be a whole number from 1 to ` +
          `${MAX_INTERACTION_CONCURRENCY}`,
      );
    }

    assertSimulationsValid(manifest);
    assertCommandsValid(manifest, this.all());
    assertContextMenusValid(manifest, this.all());

    // Before the module is stored: a duplicate or mis-namespaced provider must fail the same boot
    // that a bad defaultConfig fails, not the first time a host opens the requirement picker.
    this.#providers.register(manifest);

    this.#descriptors.set(
      manifest.id,
      zodToDescriptors(manifest.formSchema ?? manifest.configSchema),
    );
    this.#modules.set(manifest.id, manifest);
  }

  providers(): ProviderRegistry {
    return this.#providers;
  }

  async availableProviders(
    guildId: string,
    availability: ModuleAvailability,
  ): Promise<AvailableProvider[]> {
    return this.#providers.listAvailable(guildId, availability);
  }

  get(id: string): ModuleManifest | undefined {
    return this.#modules.get(id);
  }

  all(): ModuleManifest[] {
    return [...this.#modules.values()];
  }

  descriptors(id: string): FieldDescriptor[] {
    return this.#descriptors.get(id) ?? [];
  }

  // Wider than evaluate()'s gate: a rung no guild configured must not mark the module broken.
  invitePermissions(): bigint {
    return combinePermissions(
      this.all().flatMap((m) => [
        ...m.requiredPermissions,
        ...(m.actionKinds ?? []).map(invitePermissionsFor),
        ruleActionPermissions(m),
      ]),
    );
  }

  emittedTypes(): EventType[] {
    return [...new Set(this.all().flatMap((m) => m.emits ?? []))];
  }

  mayEmit(moduleId: string, type: EventType): boolean {
    return (this.#modules.get(moduleId)?.emits ?? []).includes(type);
  }

  maySchedule(moduleId: string, jobId: string): boolean {
    return (this.#modules.get(moduleId)?.schedules ?? []).includes(jobId);
  }

  mayExecute(moduleId: string, kind: ActionKind): boolean {
    return (this.#modules.get(moduleId)?.actionKinds ?? []).includes(kind);
  }

  simulations(moduleId: string): SimulationAdapter[] {
    return (this.#modules.get(moduleId)?.simulations ?? []) as SimulationAdapter[];
  }

  simulation(moduleId: string, simulationId: string): SimulationAdapter | undefined {
    return this.simulations(moduleId).find(({ descriptor }) => descriptor.id === simulationId);
  }

  requiredIntents(): number {
    return this.all()
      .flatMap((m) => m.requiredIntents)
      .reduce((acc, bit) => acc | bit, 0);
  }

  evaluate(id: string, env: RegistryEnvironment): ModuleStatus {
    const manifest = this.#modules.get(id);
    if (!manifest) {
      return {
        id,
        enabled: false,
        disabledReason: {
          code: 'missing_dependency',
          humanReason: "This module isn't running. No setting in this server can change that.",
        },
      };
    }

    const requiredIntents = manifest.requiredIntents.reduce((acc, bit) => acc | bit, 0);
    const missingIntents = requiredIntents & ~env.grantedIntents;
    if (missingIntents !== 0) {
      const intents = intentLabels(missingIntents).map((label) =>
        label.endsWith('Intent') ? label : `${label} intent`,
      );
      const one = intents.length === 1;

      return {
        id,
        enabled: false,
        disabledReason: {
          code: 'missing_intent',
          humanReason:
            `Needs the ${intents.join(' and the ')}, ` +
            ((missingIntents & PRIVILEGED_INTENTS) !== 0
              ? `which ${one ? 'is' : 'are'} off for Proton. Turn ${one ? 'it' : 'them'} on in ` +
                'the Discord Developer Portal under Bot → Privileged Gateway Intents.'
              : "which Proton isn't set up to receive. No setting in this server can change that."),
        },
      };
    }

    const requiredPermissions = combinePermissions(manifest.requiredPermissions);
    const lacking = missing(env.botPermissions, requiredPermissions);
    if (lacking !== 0n) {
      const labels = permissionLabels(lacking);
      const one = labels.length === 1;

      return {
        id,
        enabled: false,
        disabledReason: {
          code: 'missing_permission',
          humanReason:
            `Missing the ${labels.join(', ')} permission${one ? '' : 's'} in this server. Grant ` +
            `${one ? 'it' : 'them'} to Proton's role in Server Settings → Roles, or invite Proton ` +
            `again with ${one ? 'it' : 'them'}.`,
        },
      };
    }

    for (const dependency of manifest.dependsOn ?? []) {
      if (!this.#modules.has(dependency)) {
        return {
          id,
          enabled: false,
          disabledReason: {
            code: 'missing_dependency',
            humanReason:
              "Needs another Proton module that isn't running here. No setting in this server " +
              'can change that.',
          },
        };
      }
    }

    const required = manifest.requiredEntitlement;
    if (required && TIER_RANK[env.tier ?? 'free'] < TIER_RANK[required]) {
      return {
        id,
        enabled: false,
        disabledReason: {
          code: 'insufficient_entitlement',
          humanReason: "Not included in this server's plan.",
        },
      };
    }

    return { id, enabled: true };
  }
}
