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
  grantedIntents: number;

  botPermissions: bigint;
  tier?: 'free' | 'plus' | 'pro';
}

const TIER_RANK: Record<'free' | 'plus' | 'pro', number> = { free: 0, plus: 1, pro: 2 };

function intentNames(bits: number): string[] {
  const names: string[] = [];

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

export class ModuleRegistry {
  readonly #modules = new Map<string, ModuleManifest>();
  readonly #descriptors = new Map<string, FieldDescriptor[]>();

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

  invitePermissions(): bigint {
    return combinePermissions(this.all().flatMap((m) => m.requiredPermissions));
  }

  emittedTypes(): EventType[] {
    return [...new Set(this.all().flatMap((m) => m.emits ?? []))];
  }

  mayEmit(moduleId: string, type: EventType): boolean {
    return (this.#modules.get(moduleId)?.emits ?? []).includes(type);
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
