import {
  type ConfigLimit,
  checkListLimit,
  diffKeys,
  ENTITLEMENT_TIERS,
  type EntitlementTier,
  type EventBus,
  type Logger,
  type ModuleRegistry,
  newId,
  type Postable,
} from '@proton/core';
import type { DbHandle, GuildRuleStore } from '@proton/db';
import { auditTrail, guildModules, guilds } from '@proton/db/schema';
import { and, eq } from 'drizzle-orm';
import { assertWriteRefinements } from './refine-write.ts';
import { assertTemplatesValid } from './templates.ts';

export interface ModuleConfigView {
  moduleId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  schemaVersion: number;

  migrated: boolean;

  // A guild fact riding the module-config response on purpose: this is the one read every module
  // surface already makes and the worker already caches, so putting the tier anywhere else would
  // mean a second round trip per command, listener and scheduled job just to count against a limit.
  tier: EntitlementTier;

  // What this module puts in a channel and can put there again, for the dashboard's post button.
  postables: Postable[];
}

export interface RequestPanelInput {
  guildId: string;
  moduleId: string;
  panelId: string;
  actorId: string;
  source: 'dashboard' | 'command' | 'system';
  ipHash?: string | undefined;
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

function isEntitlementTier(value: unknown): value is EntitlementTier {
  return (ENTITLEMENT_TIERS as readonly string[]).includes(value as string);
}

function listAt(config: Record<string, unknown>, path: string): unknown[] | null {
  let value: unknown = config;

  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null) return null;
    value = (value as Record<string, unknown>)[segment];
  }

  return Array.isArray(value) ? value : null;
}

export function overLimit(
  limits: readonly ConfigLimit[],
  config: Record<string, unknown>,
  tier: EntitlementTier,
): string | null {
  for (const limit of limits) {
    const list = listAt(config, limit.path);
    if (list === null) continue;

    const check = checkListLimit(tier, limit.key, list.length);
    if (!check.ok) return check.humanReason;
  }

  return null;
}

// A module that has renamed a config key lifts the old shape here, before Zod sees it and strips
// the key it no longer knows. Applied on read and on write, so a caller posting the old shape is
// migrated rather than silently emptied.
function lift(
  manifest: { liftStoredConfig?(raw: unknown, current?: Record<string, unknown>): unknown },
  raw: unknown,
  current?: Record<string, unknown>,
): unknown {
  return manifest.liftStoredConfig ? manifest.liftStoredConfig(raw, current) : raw;
}

/**
 * Derived from the config being returned, never stored: a panel added or renamed on the page is a
 * different postable the moment the save lands, and a cached list would draw a button for one that
 * no longer exists. Guarded, because `postables` is a module's own code and a throw here would take
 * the whole settings page down over a button.
 */
function postablesOf(
  manifest: { id: string; postables?(config: never): Postable[] },
  config: unknown,
): Postable[] {
  if (!manifest.postables) return [];

  try {
    return manifest.postables(config as never);
  } catch {
    return [];
  }
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
      throw new ModuleConfigError('unknown_module', `Proton has no module called '${moduleId}'.`);
    }
    return manifest;
  }

  async #tier(guildId: string): Promise<EntitlementTier> {
    const rows = await this.#db.db
      .select({ tier: guilds.tier })
      .from(guilds)
      .where(eq(guilds.id, guildId))
      .limit(1);

    const stored = rows[0]?.tier;
    return isEntitlementTier(stored) ? stored : 'free';
  }

  async enabledMap(guildId: string): Promise<Record<string, boolean>> {
    const rows = await this.#db.db
      .select({ moduleId: guildModules.moduleId, enabled: guildModules.enabled })
      .from(guildModules)
      .where(eq(guildModules.guildId, guildId));

    return Object.fromEntries(rows.map((row) => [row.moduleId, row.enabled]));
  }

  async get(guildId: string, moduleId: string): Promise<ModuleConfigView> {
    const manifest = this.#manifest(moduleId);

    const [rows, tier] = await Promise.all([
      this.#db.db
        .select()
        .from(guildModules)
        .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleId, moduleId)))
        .limit(1),
      this.#tier(guildId),
    ]);

    const row = rows[0];

    if (!row) {
      return {
        moduleId,
        enabled: false,
        config: manifest.defaultConfig as Record<string, unknown>,
        schemaVersion: manifest.schemaVersion,
        migrated: false,
        tier,
        postables: postablesOf(manifest, manifest.defaultConfig),
      };
    }

    const parsed = manifest.configSchema.safeParse(lift(manifest, row.config));
    if (!parsed.success) {
      throw new ModuleConfigError(
        'invalid_stored_config',
        `Proton could not read this server's ${manifest.name} settings: ${parsed.error.issues
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
      tier,
      postables: postablesOf(manifest, parsed.data),
    };
  }

  /**
   * "Post it now", from the dashboard. This process has no Discord client and must not acquire one
   * — the worker is the only one allowed to talk to Discord — so everything that can be checked
   * here is checked here, and then the module's own listener does the posting.
   *
   * What is checked: the module exists, is switched on, declares postables, and still has one under
   * the id the button was drawn for. The answer is "asked", never "posted": the send happens in
   * another process and this one would be guessing.
   */
  async requestPanel(input: RequestPanelInput): Promise<{ auditId: string; name: string }> {
    const manifest = this.#manifest(input.moduleId);

    if (!manifest.postables) {
      throw new ModuleConfigError(
        'not_postable',
        `${manifest.name} has nothing Proton posts into a channel, so there is nothing to send.`,
      );
    }

    const current = await this.get(input.guildId, input.moduleId);
    if (!current.enabled) {
      throw new ModuleConfigError(
        'module_disabled',
        `${manifest.name} is switched off in this server, so posting this would put a message ` +
          'nobody can use in a channel. Switch it on first.',
      );
    }

    const found = manifest
      .postables(current.config as never)
      .find((candidate) => candidate.id === input.panelId);

    if (!found) {
      throw new ModuleConfigError(
        'unknown_panel',
        `${manifest.name} has nothing called '${input.panelId}' to post. It may have been renamed ` +
          'or removed since this page was opened — reload and try again.',
      );
    }

    if (!found.channelId) {
      throw new ModuleConfigError(
        'no_channel',
        `'${found.name}' has no channel to go in yet. Pick one and save, then post it.`,
      );
    }

    const bus = this.#options.bus;
    if (!bus) {
      throw new ModuleConfigError(
        'no_bus',
        'Proton cannot reach its event bus, and the worker is the only process allowed to talk ' +
          'to Discord, so nothing was sent. Set REDIS_URL for the api and restart it.',
      );
    }

    const auditId = newId();

    await this.#db.db.insert(auditTrail).values({
      id: auditId,
      guildId: input.guildId,
      actorId: input.actorId,
      source: input.source,
      action: `module.${input.moduleId}.panel.post`,
      before: null,
      after: { panelId: found.id, name: found.name, channelId: found.channelId },
      ipHash: input.ipHash ?? null,
    });

    // After the audit row, never before: an event for a request with no durable record is one
    // nobody can trace back to whoever pressed the button.
    await bus.publish({
      id: `proton.panel_requested:${input.guildId}:${auditId}`,
      type: 'proton.panel_requested',
      guildId: input.guildId,
      occurredAt: this.#options.now?.() ?? Date.now(),
      payload: {
        auditId,
        guildId: input.guildId,
        moduleId: input.moduleId,
        panelId: found.id,
        actorId: input.actorId,
      },
    });

    return { auditId, name: found.name };
  }

  /**
   * Closing an anti-nuke maintenance window early re-arms the breaker, which is exactly the kind
   * of security decision the audit trail exists for. Recorded here rather than in the route
   * because this service is the one that owns the database handle.
   */
  async recordMaintenanceEnded(
    guildId: string,
    actorId: string,
    before: { enabledBy: string; reason: string | null; expiresAt: number } | null,
  ): Promise<void> {
    await this.#db.db.insert(auditTrail).values({
      id: newId(),
      guildId,
      actorId,
      source: 'dashboard',
      action: 'module.antinuke.maintenance.end',
      before: before === null ? null : { ...before },
      after: null,
      ipHash: null,
    });
  }

  async update(input: UpdateModuleConfigInput): Promise<{
    before: ModuleConfigView;
    after: ModuleConfigView;
  }> {
    const manifest = this.#manifest(input.moduleId);
    const before = await this.get(input.guildId, input.moduleId);

    // Every module carries its own `enabled` field alongside the guild_modules row, and
    // disabledReason treats either being false as off. One switch drives both, so a module that
    // is on in the dashboard can never sit on a stored config that says otherwise. A schema
    // without the field strips the extra key on parse.
    const nextConfigRaw =
      input.enabled === undefined
        ? (input.config ?? before.config)
        : { ...(input.config ?? before.config), enabled: input.enabled };

    const parsed = manifest.configSchema.safeParse(lift(manifest, nextConfigRaw, before.config));
    if (!parsed.success) {
      throw new ModuleConfigError(
        'invalid_config',
        `Those ${manifest.name} settings were not saved: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    const nextConfig = parsed.data as Record<string, unknown>;

    assertWriteRefinements(manifest, nextConfig, before.config);

    const exceeded = overLimit(manifest.configLimits ?? [], nextConfig, before.tier);
    if (exceeded) {
      throw new ModuleConfigError(
        'over_limit',
        `Those ${manifest.name} settings were not saved: ${exceeded}`,
      );
    }

    assertTemplatesValid(manifest, nextConfig, before.config);

    const nextEnabled = input.enabled ?? before.enabled;

    const after: ModuleConfigView = {
      moduleId: input.moduleId,
      enabled: nextEnabled,
      config: nextConfig,
      schemaVersion: manifest.schemaVersion,
      migrated: false,
      tier: before.tier,
      postables: postablesOf(manifest, nextConfig),
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
