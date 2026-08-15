import { GatewayIntentBits } from 'discord-api-types/v10';
import { type FieldDescriptor, zodToDescriptors } from '../config/descriptor.ts';
import type { EventType } from '../events/types.ts';
import { combinePermissions, missing, permissionNames } from '../permissions/bits.ts';
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
  /** Bitfield of intents actually granted to the application. */
  grantedIntents: number;
  /** The bot's guild-level permissions. */
  botPermissions: bigint;
  tier?: 'free' | 'plus' | 'pro';
}

const TIER_RANK: Record<'free' | 'plus' | 'pro', number> = { free: 0, plus: 1, pro: 2 };

function intentNames(bits: number): string[] {
  const names: string[] = [];
  // Entries are typed as the enum, so widen to number before doing bit maths.
  for (const [name, value] of Object.entries(GatewayIntentBits) as Array<[string, number]>) {
    if (value !== 0 && (bits & value) === value) names.push(name);
  }
  return names;
}

export class ModuleRegistrationError extends Error {
  constructor(moduleId: string, detail: string) {
    super(`Module '${moduleId}' is invalid: ${detail}`);
    this.name = 'ModuleRegistrationError';
  }
}

/**
 * Loads module manifests and decides which may run (PLAN.md §7).
 *
 * Two framework guarantees live here rather than in each module:
 *   - a module missing a required intent disables itself and says which intent;
 *   - a module missing a Discord permission says which permission, and where.
 * Both are structural. A module author cannot forget to implement them, and
 * "the bot did nothing" stops being a possible outcome.
 */
export class ModuleRegistry {
  readonly #modules = new Map<string, ModuleManifest>();
  readonly #descriptors = new Map<string, FieldDescriptor[]>();

  /**
   * Register a manifest, validating it eagerly.
   *
   * Every check here fails at load time — in the module's own tests — rather
   * than in production when a guild admin opens the settings page.
   */
  register(manifest: ModuleManifest): void {
    if (this.#modules.has(manifest.id)) {
      throw new ModuleRegistrationError(manifest.id, 'a module with this id is already registered');
    }

    // The default config must satisfy the module's own schema. Without this, a
    // schema change that forgets defaultConfig ships a module nobody can enable.
    const parsed = manifest.configSchema.safeParse(manifest.defaultConfig);
    if (!parsed.success) {
      throw new ModuleRegistrationError(
        manifest.id,
        `defaultConfig does not satisfy configSchema: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    // A form field with no matching config key writes into nothing: the module
    // would validate the saved object, drop the unknown key, and the admin would
    // watch their setting revert. Caught here rather than in their browser.
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

    // A duplicated emit is harmless at runtime but always a mistake — usually a
    // copy-paste while adding a second event — and `emittedTypes()` is a union,
    // so the duplicate would be invisible there. Say it here instead.
    const emits = manifest.emits ?? [];
    const duplicated = emits.filter((type, index) => emits.indexOf(type) !== index);
    if (duplicated.length > 0) {
      throw new ModuleRegistrationError(
        manifest.id,
        `emits lists ${[...new Set(duplicated)].join(', ')} more than once`,
      );
    }

    // The dashboard must be able to render it. Failing now turns an unsupported
    // schema into a failing unit test instead of a blank form.
    this.#descriptors.set(
      manifest.id,
      zodToDescriptors(manifest.formSchema ?? manifest.configSchema),
    );
    this.#modules.set(manifest.id, manifest);
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

  /** Union of every registered module's permissions — the invite URL integer (§10.3). */
  invitePermissions(): bigint {
    return combinePermissions(this.all().flatMap((m) => m.requiredPermissions));
  }

  /**
   * Every event type some registered module may publish.
   *
   * The second half of "which types does anything actually emit" — the first is
   * the gateway's `NORMALISED_EVENT_TYPES`. A listener subscribing to a type in
   * neither set can never fire, which is the failure `packages/modules/registry`
   * asserts against.
   */
  emittedTypes(): EventType[] {
    return [...new Set(this.all().flatMap((m) => m.emits ?? []))];
  }

  /** Whether this module declared it may publish this type (I3's allowlist). */
  mayEmit(moduleId: string, type: EventType): boolean {
    return (this.#modules.get(moduleId)?.emits ?? []).includes(type);
  }

  /** Union of every registered module's intents — the gateway Identify bitfield. */
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
        disabledReason: { code: 'missing_dependency', humanReason: `No module '${id}' is loaded.` },
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
            `${manifest.name} needs the ${intentNames(missingIntents).join(', ')} ` +
            'intent, which is not enabled for this application. Turn it on in the ' +
            'Discord developer portal under Bot → Privileged Gateway Intents.',
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
            `${manifest.name} needs the ${permissionNames(lacking).join(', ')} ` +
            'permission, which the bot does not have in this server. Grant it in ' +
            'Server Settings → Roles, or re-invite the bot with the correct permissions.',
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
            humanReason: `${manifest.name} depends on the '${dependency}' module, which is not loaded.`,
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
          humanReason: `${manifest.name} requires the ${required} tier.`,
        },
      };
    }

    return { id, enabled: true };
  }
}
