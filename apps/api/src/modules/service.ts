import { type ModuleRegistry, newId } from '@proton/core';
import type { DbHandle } from '@proton/db';
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

export class ModuleConfigService {
  readonly #db: DbHandle;
  readonly #registry: ModuleRegistry;

  constructor(db: DbHandle, registry: ModuleRegistry) {
    this.#db = db;
    this.#registry = registry;
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
        id: newId(),
        guildId: input.guildId,
        actorId: input.actorId,
        source: input.source,
        action: `module.${input.moduleId}.update`,
        before: { enabled: before.enabled, config: before.config },
        after: { enabled: after.enabled, config: after.config },
        ipHash: input.ipHash ?? null,
      });
    });

    return { before, after };
  }
}
