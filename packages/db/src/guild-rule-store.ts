import {
  type EventType,
  type GuildRule,
  guildRuleSchema,
  type RuleDefinition,
  ruleDefinitionSchema,
} from '@proton/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { ZodError } from 'zod';
import type { DbHandle } from './client.ts';
import { rules } from './schema/rules.ts';

export const PRESET_CREATED_BY = 'proton:preset';

export const guildRuleRowId = (guildId: string, moduleId: string, ruleId: string): string =>
  `${guildId}:${moduleId}:${ruleId}`;

export function ruleIdFromRow(row: { id: string; guildId: string; moduleId: string }): string {
  const prefix = `${row.guildId}:${row.moduleId}:`;
  return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
}

export interface InvalidRuleContext {
  guildId: string;
  moduleId: string;
  ruleId: string;

  source: 'stored' | 'preset';
}

export interface GuildRuleStoreOptions {
  onInvalidRule?(context: InvalidRuleContext, detail: string): void;
}

export interface GuildRuleStore {
  listForEvent(guildId: string, eventType: EventType): Promise<GuildRule[]>;

  listCron(guildId: string): Promise<GuildRule[]>;

  seedPresets(
    guildId: string,
    moduleId: string,
    presets: readonly RuleDefinition[],
  ): Promise<number>;

  replaceModuleRules(
    guildId: string,
    moduleId: string,
    compiled: readonly RuleDefinition[],
  ): Promise<number>;
}

const issuesOf = (error: ZodError): string =>
  error.issues.map((i) => `${i.path.map(String).join('.') || 'rule'} ${i.message}`).join('; ');

export class DrizzleGuildRuleStore implements GuildRuleStore {
  readonly #handle: DbHandle;
  readonly #options: GuildRuleStoreOptions;

  constructor(handle: DbHandle, options: GuildRuleStoreOptions = {}) {
    this.#handle = handle;
    this.#options = options;
  }

  async listForEvent(guildId: string, eventType: EventType): Promise<GuildRule[]> {
    const found = await this.#handle.db
      .select()
      .from(rules)
      .where(and(eq(rules.guildId, guildId), eq(rules.triggerEvent, eventType)))
      .orderBy(rules.priority, rules.id);

    return this.#parse(found);
  }

  async listCron(guildId: string): Promise<GuildRule[]> {
    const found = await this.#handle.db
      .select()
      .from(rules)
      .where(and(eq(rules.guildId, guildId), isNull(rules.triggerEvent)))
      .orderBy(rules.priority, rules.id);

    return this.#parse(found).filter((rule) => rule.trigger.kind === 'cron');
  }

  async seedPresets(
    guildId: string,
    moduleId: string,
    presets: readonly RuleDefinition[],
  ): Promise<number> {
    const values: (typeof rules.$inferInsert)[] = [];

    for (const [index, preset] of presets.entries()) {
      const parsed = ruleDefinitionSchema.safeParse(preset);
      if (!parsed.success) {
        this.#options.onInvalidRule?.(
          {
            guildId,
            moduleId,
            ruleId: typeof preset?.id === 'string' ? preset.id : `#${index}`,
            source: 'preset',
          },
          issuesOf(parsed.error),
        );
        continue;
      }

      const rule = parsed.data;
      values.push({
        id: guildRuleRowId(guildId, moduleId, rule.id),
        guildId,
        moduleId,

        trigger: rule.trigger,
        conditions: rule.conditions,
        actions: rule.actions,
        enabled: rule.enabled,
        priority: rule.priority,
        createdBy: PRESET_CREATED_BY,
      });
    }

    if (values.length === 0) return 0;

    const inserted = await this.#handle.db
      .insert(rules)
      .values(values)
      // Never upsert: an overwrite would re-enable a preset the guild disabled, on every reconnect.
      .onConflictDoNothing({ target: rules.id })
      .returning({ id: rules.id });

    return inserted.length;
  }

  // Config → rules, run on every save. `seedPresets` cannot do this: it is insert-only, so an
  // edited escalation ladder would leave the original rules in place and change nothing.
  async replaceModuleRules(
    guildId: string,
    moduleId: string,
    compiled: readonly RuleDefinition[],
  ): Promise<number> {
    const values = this.#toRows(guildId, moduleId, compiled);

    return this.#handle.db.transaction(async (tx) => {
      // A guild's decision to switch a rung off must survive a recompile, so the existing enabled
      // flags are read before the delete and reapplied by id. A rule whose id changed is new and
      // takes the compiler's default.
      const existing = await tx
        .select({ id: rules.id, enabled: rules.enabled })
        .from(rules)
        .where(and(eq(rules.guildId, guildId), eq(rules.moduleId, moduleId)));

      const wasEnabled = new Map(existing.map((row) => [row.id, row.enabled]));

      await tx.delete(rules).where(and(eq(rules.guildId, guildId), eq(rules.moduleId, moduleId)));

      if (values.length === 0) return 0;

      const withPriorState = values.map((row) => ({
        ...row,
        enabled: wasEnabled.get(row.id) ?? row.enabled,
      }));

      const inserted = await tx.insert(rules).values(withPriorState).returning({ id: rules.id });
      return inserted.length;
    });
  }

  #toRows(
    guildId: string,
    moduleId: string,
    definitions: readonly RuleDefinition[],
  ): (typeof rules.$inferInsert)[] {
    const values: (typeof rules.$inferInsert)[] = [];

    for (const [index, definition] of definitions.entries()) {
      const parsed = ruleDefinitionSchema.safeParse(definition);
      if (!parsed.success) {
        this.#options.onInvalidRule?.(
          {
            guildId,
            moduleId,
            ruleId: typeof definition?.id === 'string' ? definition.id : `#${index}`,
            source: 'preset',
          },
          issuesOf(parsed.error),
        );
        continue;
      }

      const rule = parsed.data;
      values.push({
        id: guildRuleRowId(guildId, moduleId, rule.id),
        guildId,
        moduleId,
        trigger: rule.trigger,
        conditions: rule.conditions,
        actions: rule.actions,
        enabled: rule.enabled,
        priority: rule.priority,
        createdBy: PRESET_CREATED_BY,
      });
    }

    return values;
  }

  #parse(found: (typeof rules.$inferSelect)[]): GuildRule[] {
    const parsed: GuildRule[] = [];

    for (const row of found) {
      const ruleId = ruleIdFromRow(row);
      const result = guildRuleSchema.safeParse({ ...row, id: ruleId });
      if (!result.success) {
        this.#options.onInvalidRule?.(
          { guildId: row.guildId, moduleId: row.moduleId, ruleId, source: 'stored' },
          issuesOf(result.error),
        );
        continue;
      }
      parsed.push(result.data);
    }

    return parsed;
  }
}
