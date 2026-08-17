import { diffKeys, type EventBus, type Logger, type ModuleRegistry, newId } from '@proton/core';
import type { DbHandle, GuildRuleStore } from '@proton/db';
import { auditTrail, guildModules } from '@proton/db/schema';
import { and, eq } from 'drizzle-orm';

export interface ModuleConfigView {
  moduleId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  schemaVersion: number;

  migrated: boolean;
}

export interface UpdateModuleConfigInput {
  guildId: string;
  moduleId: string;

  enabled?: boolean | undefined;
  config?: Record<string, unknown> | undefined;
  actorId: string;
  source: 'dashboard' | 'command' | 'system';
  ipHash?: string | undefined;
}

export class ModuleConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ModuleConfigError';
  }
}

export interface ModuleConfigServiceOptions {
  rules?: GuildRuleStore;
  onRecompileFailed?(guildId: string, moduleId: string, detail: string): void;

  bus?: EventBus;
  logger?: Logger;
  now?(): number;
}

export class ModuleConfigService {
  readonly #db: DbHandle;
  readonly #registry: ModuleRegistry;
  readonly #options: ModuleConfigServiceOptions;

  constructor(db: DbHandle, registry: ModuleRegistry, options: ModuleConfigServiceOptions = {}) {
    this.#db = db;
    this.#registry = registry;
    this.#options = options;
  }

  #manifest(moduleId: string) {
    const manifest = this.#registry.get(moduleId);
    if (!manifest) {
      throw new ModuleConfigError('unknown_module', `No module '${moduleId}' is loaded.`);
    }
    return manifest;
  }

  async get(guildId: string, moduleId: string): Promise<ModuleConfigView> {
    const manifest = this.#manifest(moduleId);

    const rows = await this.#db.db
      .select()
      .from(guildModules)
      .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleId, moduleId)))
      .limit(1);

    const row = rows[0];

    if (!row) {
      return {
        moduleId,
        enabled: false,
        config: manifest.defaultConfig as Record<string, unknown>,
        schemaVersion: manifest.schemaVersion,
        migrated: false,
      };
    }

    const parsed = manifest.configSchema.safeParse(row.config);
    if (!parsed.success) {
      throw new ModuleConfigError(
        'invalid_stored_config',
        `Stored config for '${moduleId}' in guild ${guildId} does not satisfy its schema: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    const migrated = row.schemaVersion !== manifest.schemaVersion;

    return {
      moduleId,
      enabled: row.enabled,
      config: parsed.data as Record<string, unknown>,
      schemaVersion: manifest.schemaVersion,
      migrated,
    };
  }

  async update(input: UpdateModuleConfigInput): Promise<{
    before: ModuleConfigView;
    after: ModuleConfigView;
  }> {
    const manifest = this.#manifest(input.moduleId);
    const before = await this.get(input.guildId, input.moduleId);

    const nextConfigRaw = input.config ?? before.config;
    const parsed = manifest.configSchema.safeParse(nextConfigRaw);
    if (!parsed.success) {
      throw new ModuleConfigError(
        'invalid_config',
        `Invalid config for '${input.moduleId}': ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    const nextConfig = parsed.data as Record<string, unknown>;
    const nextEnabled = input.enabled ?? before.enabled;

    const after: ModuleConfigView = {
      moduleId: input.moduleId,
      enabled: nextEnabled,
      config: nextConfig,
      schemaVersion: manifest.schemaVersion,
      migrated: false,
    };

    // Hoisted out of the transaction so the published event can carry the same id as the durable
    // audit row it describes.
    const auditId = newId();

    await this.#db.db.transaction(async (tx) => {
      await tx
        .insert(guildModules)
        .values({
          guildId: input.guildId,
          moduleId: input.moduleId,
          enabled: nextEnabled,
          config: nextConfig,
          schemaVersion: manifest.schemaVersion,
          updatedBy: input.actorId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [guildModules.guildId, guildModules.moduleId],
          set: {
            enabled: nextEnabled,
            config: nextConfig,
            schemaVersion: manifest.schemaVersion,
            updatedBy: input.actorId,
            updatedAt: new Date(),
          },
        });

      await tx.insert(auditTrail).values({
        id: auditId,
        guildId: input.guildId,
        actorId: input.actorId,
        source: input.source,
        action: `module.${input.moduleId}.update`,
        before: { enabled: before.enabled, config: before.config },
        after: { enabled: after.enabled, config: after.config },
        ipHash: input.ipHash ?? null,
      });
    });

    await this.#recompileRules(input.guildId, input.moduleId, nextConfig);
    await this.#publishChange(auditId, input, before, after);

    return { before, after };
  }

  // After the commit, never inside it: an event for a rolled-back write is a lie, and a Redis
  // round trip inside the transaction would hold the row lock for the length of it.
  async #publishChange(
    auditId: string,
    input: UpdateModuleConfigInput,
    before: ModuleConfigView,
    after: ModuleConfigView,
  ): Promise<void> {
    const bus = this.#options.bus;
    if (!bus) return;

    const changedKeys = diffKeys(before.config, after.config);
    if (changedKeys.length === 0 && before.enabled === after.enabled) return;

    try {
      await bus.publish({
        id: `proton.config_changed:${input.guildId}:${auditId}`,
        type: 'proton.config_changed',
        guildId: input.guildId,
        occurredAt: this.#options.now?.() ?? Date.now(),
        payload: {
          auditId,
          guildId: input.guildId,
          moduleId: input.moduleId,
          moduleName: this.#registry.get(input.moduleId)?.name ?? input.moduleId,
          actorId: input.actorId,
          source: input.source,
          enabledBefore: before.enabled,
          enabledAfter: after.enabled,
          changedKeys,
        },
      });
    } catch (error) {
      // The audit_trail row is the durable record; the log post is best effort and must never
      // fail an admin's save.
      this.#options.logger?.error(
        `${input.moduleId}'s config was saved for guild ${input.guildId} but the change could ` +
          `not be published, so no Proton log was posted for it: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  // After the commit, never inside it. The config is the source of truth and the rules are derived
  // from it, so a recompile that fails must not roll back a save the admin already saw succeed —
  // the next save, or the next `guild.available`, re-derives them.
  async #recompileRules(
    guildId: string,
    moduleId: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const store = this.#options.rules;
    const manifest = this.#registry.get(moduleId);
    if (!store || !manifest?.compileRules) return;

    try {
      await store.replaceModuleRules(guildId, moduleId, manifest.compileRules(config));
    } catch (error) {
      this.#options.onRecompileFailed?.(
        guildId,
        moduleId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
