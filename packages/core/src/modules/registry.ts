import { GatewayIntentBits } from 'discord-api-types/v10';
import { type ActionKind, REQUIRED_PERMISSIONS } from '../actions/kinds.ts';
import { type FieldDescriptor, zodToDescriptors } from '../config/descriptor.ts';
import type { EventType } from '../events/types.ts';
import { combinePermissions, missing, Permissions, permissionLabels } from '../permissions/bits.ts';
import type { AvailableProvider } from '../providers/registry.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import type { ModuleAvailability } from '../providers/types.ts';
import type { ModuleManifest } from './manifest.ts';

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
  send: Permissions.SendPolls | Permissions.EmbedLinks | Permissions.AttachFiles,
  edit_message: 0n,
  delete_message: 0n,
  add_reaction: 0n,
  interaction_reply: 0n,
  interaction_followup: 0n,
  warn: 0n,
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
  delete_channel: 0n,
  edit_channel: Permissions.ManageRoles,
  set_channel_overwrite: 0n,
  delete_channel_overwrite: 0n,
  create_thread: Permissions.CreatePublicThreads | Permissions.CreatePrivateThreads,
  move_member: 0n,
  end_poll: 0n,
  pin_message: 0n,
  automod_rule_create: 0n,
  automod_rule_update: 0n,
  automod_rule_delete: 0n,
  giveaway_draw: 0n,
  create_dm: 0n,
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
          humanReason: "This module isn't part of the Proton deployment running here.",
        },
      };
    }

    const requiredIntents = manifest.requiredIntents.reduce((acc, bit) => acc | bit, 0);
    const missingIntents = requiredIntents & ~env.grantedIntents;
    if (missingIntents !== 0) {
      return {
        id,
        enabled: false,
        disabledReason: {
          code: 'missing_intent',
          humanReason:
            `${manifest.name} can't run without ${intentLabels(missingIntents).join(' and ')}, ` +
            ((missingIntents & PRIVILEGED_INTENTS) !== 0
              ? 'which is switched off for this bot. Turn it on in the Discord developer ' +
                'portal, under Bot → Privileged Gateway Intents.'
              : "which this Proton deployment doesn't connect with. Nothing in this server's " +
                'settings can change that.'),
        },
      };
    }

    const requiredPermissions = combinePermissions(manifest.requiredPermissions);
    const lacking = missing(env.botPermissions, requiredPermissions);
    if (lacking !== 0n) {
      return {
        id,
        enabled: false,
        disabledReason: {
          code: 'missing_permission',
          humanReason:
            `${manifest.name} needs the ${permissionLabels(lacking).join(', ')} permission` +
            `${permissionLabels(lacking).length === 1 ? '' : 's'}, which Proton doesn't have in ` +
            'this server. Grant it in Server Settings → Roles, or re-invite the bot with it.',
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
              `${manifest.name} needs another Proton module that this deployment isn't ` +
              "running. Nothing in this server's settings can change that.",
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
          humanReason: `${manifest.name} isn't included on this server's plan.`,
        },
      };
    }

    return { id, enabled: true };
  }
}
