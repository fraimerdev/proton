import type { FieldDescriptor } from '../config/descriptor.ts';
import { CORE_MODULE_ID, CORE_PROVIDERS } from './builtins.ts';
import {
  type ConditionProvider,
  isConditionProvider,
  type ModuleAvailability,
  type MultiplierProvider,
  type Provider,
  type ProviderKind,
} from './types.ts';

// Discord modals hold "between 1 and 5 (inclusive)" top-level components, and every descriptor
// renders as one Label. A sixth field is a 400 from Discord at the moment a host opens the builder.
export const PROVIDER_BUILDER_MAX = 5;

export class ProviderRegistrationError extends Error {
  constructor(providerId: string, detail: string) {
    super(`Provider '${providerId}' is invalid: ${detail}`);
    this.name = 'ProviderRegistrationError';
  }
}

export interface AvailableProvider {
  id: string;
  moduleId: string;
  kind: ProviderKind;
  label: string;
  description: string;
  emoji?: string;
  builder: FieldDescriptor[];
}

export interface ProviderOwner {
  id: string;
  providers?: readonly Provider[];
}

export type ParseConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; humanReason: string };

function toAvailable(provider: Provider): AvailableProvider {
  return {
    id: provider.id,
    moduleId: provider.moduleId,
    kind: provider.kind,
    label: provider.label,
    description: provider.description,
    ...(provider.emoji !== undefined ? { emoji: provider.emoji } : {}),
    builder: provider.builder,
  };
}

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();

  constructor(options: { builtins?: boolean } = {}) {
    if (options.builtins !== false) {
      this.register({ id: CORE_MODULE_ID, providers: CORE_PROVIDERS });
    }
  }

  register(owner: ProviderOwner): void {
    for (const provider of owner.providers ?? []) {
      this.#validate(owner.id, provider);
      this.#providers.set(provider.id, provider);
    }
  }

  #validate(moduleId: string, provider: Provider): void {
    if (this.#providers.has(provider.id)) {
      const existing = this.#providers.get(provider.id);
      throw new ProviderRegistrationError(
        provider.id,
        `the '${existing?.moduleId}' module already registered this id. Provider ids are the ` +
          'stored key for every requirement and multiplier a guild has configured, so two ' +
          'implementations behind one id would silently swap behaviour between deploys.',
      );
    }

    if (provider.moduleId !== moduleId) {
      throw new ProviderRegistrationError(
        provider.id,
        `it declares moduleId '${provider.moduleId}' but was registered by '${moduleId}'. ` +
          'A module may only register its own providers — that is what keeps a module from ' +
          'reaching into another one.',
      );
    }

    const prefix = `${moduleId}.`;
    if (!provider.id.startsWith(prefix) || provider.id.length === prefix.length) {
      throw new ProviderRegistrationError(
        provider.id,
        `its id must be namespaced as '${prefix}<name>' so the owning module is readable from ` +
          'any stored requirement row.',
      );
    }

    if (provider.builder.length > PROVIDER_BUILDER_MAX) {
      throw new ProviderRegistrationError(
        provider.id,
        `its builder has ${provider.builder.length} fields and a Discord modal holds at most ` +
          `${PROVIDER_BUILDER_MAX}. Split it into two providers, or drop a field.`,
      );
    }

    const shape = new Set(Object.keys(provider.configSchema.shape));
    for (const field of provider.builder) {
      const root = field.path.split('.')[0] ?? field.path;
      if (!shape.has(root)) {
        throw new ProviderRegistrationError(
          provider.id,
          `its builder describes '${field.path}', which is not in its configSchema. The builder ` +
            'should be derived with zodToDescriptors(configSchema) rather than written by hand.',
        );
      }
    }

    if (provider.cost === 'query' && provider.batchEvaluate === undefined) {
      throw new ProviderRegistrationError(
        provider.id,
        "it declares cost 'query' but has no batchEvaluate. Revalidating ten thousand entrants " +
          'one query at a time is ten thousand queries; a query-backed provider has to be able ' +
          'to answer for a whole batch in one statement.',
      );
    }
  }

  condition(id: string): ConditionProvider | undefined {
    const provider = this.#providers.get(id);
    return provider && isConditionProvider(provider) ? provider : undefined;
  }

  multiplier(id: string): MultiplierProvider | undefined {
    const provider = this.#providers.get(id);
    return provider && !isConditionProvider(provider) ? provider : undefined;
  }

  get(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  all(): readonly Provider[] {
    return [...this.#providers.values()];
  }

  ownedBy(moduleId: string): readonly Provider[] {
    return this.all().filter((provider) => provider.moduleId === moduleId);
  }

  async listAvailable(
    guildId: string,
    availability: ModuleAvailability,
  ): Promise<AvailableProvider[]> {
    const moduleIds = [...new Set(this.all().map((provider) => provider.moduleId))];
    const enabled = new Map<string, boolean>();

    await Promise.all(
      moduleIds.map(async (moduleId) => {
        // No guild_modules row exists for core, and there is nothing to switch off — asking would
        // answer false and strip the only conditions every guild can always use.
        enabled.set(
          moduleId,
          moduleId === CORE_MODULE_ID ? true : await availability.isEnabled(guildId, moduleId),
        );
      }),
    );

    return this.all()
      .filter((provider) => enabled.get(provider.moduleId) === true)
      .map(toAvailable)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  parseConfig(id: string, raw: unknown): ParseConfigResult {
    const provider = this.#providers.get(id);
    if (!provider) {
      return {
        ok: false,
        humanReason:
          `No provider '${id}' is loaded, so what it was configured with cannot be read. The ` +
          'module that owns it is probably not running in this deployment.',
      };
    }

    const parsed = provider.configSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        humanReason: `The settings saved for ${provider.label} are not valid: ${parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || 'value'} ${issue.message}`)
          .join('; ')}.`,
      };
    }

    return { ok: true, config: parsed.data as Record<string, unknown> };
  }
}
