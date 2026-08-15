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

/**
 * `rules.created_by` for a row a module shipped rather than an admin authored.
 *
 * Not a snowflake, on the same reasoning as `RULE_ENGINE_ACTOR`: nobody created
 * it. It is also the only thing that tells a seeded preset apart from a rule a
 * guild wrote by hand, which the dashboard needs before it can offer to reset a
 * ladder to its defaults — with no marker, the two are indistinguishable rows.
 */
export const PRESET_CREATED_BY = 'proton:preset';

/**
 * The primary key of a stored rule.
 *
 * `rules.id` is a bare primary key over the whole table, so it has to carry the
 * guild; the rule's own `id` is only unique within its declaring module. Exported
 * because the seeder computes it on write and `ruleIdFromRow` reverses it on
 * read, and the two must agree — a second spelling of this template anywhere is
 * a preset that re-inserts itself on every reconnect.
 */
export const guildRuleRowId = (guildId: string, moduleId: string, ruleId: string): string =>
  `${guildId}:${moduleId}:${ruleId}`;

/**
 * Recover the rule's own id from a stored row.
 *
 * `ruleShape.id` is documented as "unique within the declaring module", and the
 * engine builds both the rate-window key (`moduleId:ruleId`) and every
 * idempotency key from it. Handing it the composite primary key instead would
 * still be unique, but it would bake the guild into keys that already carry the
 * guild beside them, and it would mean `escalationRuleId(rung)` — the module's
 * own stable name for a ladder rung — never appears anywhere it can be matched.
 *
 * Only strips a prefix that is actually there, so a row written by some other
 * writer (an admin-authored rule from the future rule builder) keeps its id
 * verbatim rather than being silently truncated.
 */
export function ruleIdFromRow(row: { id: string; guildId: string; moduleId: string }): string {
  const prefix = `${row.guildId}:${row.moduleId}:`;
  return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
}

/** Identifies the rule a report is about, before it is known to be valid. */
export interface InvalidRuleContext {
  guildId: string;
  moduleId: string;
  ruleId: string;
  /** `stored` = a row read back; `preset` = a manifest rule refused on the way in. */
  source: 'stored' | 'preset';
}

export interface GuildRuleStoreOptions {
  /**
   * A rule that does not satisfy its schema, with the issues named.
   *
   * The store has no logger of its own — `packages/db` is imported by the API and
   * the dashboard as well as the worker — so the caller decides where this goes.
   * Defaulting to silence would make a rule that stopped parsing look exactly
   * like a guild that has no rules.
   */
  onInvalidRule?(context: InvalidRuleContext, detail: string): void;
}

/**
 * Reads and seeds §6's `rules` (PLAN.md §4-P2, PHASE-3 G4).
 *
 * The port lives here rather than in `packages/core` because the plan puts it
 * here, and because its two callers — the worker's dispatch runtime and its
 * preset seeder — both already depend on `@proton/db`.
 */
export interface GuildRuleStore {
  /** This guild's rules for one event type, in the order the engine will run them. */
  listForEvent(guildId: string, eventType: EventType): Promise<GuildRule[]>;
  /** This guild's cron-triggered rules. Never candidates for event dispatch. */
  listCron(guildId: string): Promise<GuildRule[]>;
  /** Insert a module's presets for a guild, never overwriting. Returns how many were new. */
  seedPresets(
    guildId: string,
    moduleId: string,
    presets: readonly RuleDefinition[],
  ): Promise<number>;
}

const issuesOf = (error: ZodError): string =>
  error.issues.map((i) => `${i.path.map(String).join('.') || 'rule'} ${i.message}`).join('; ');

/** Postgres implementation of §6's `rules`. */
export class DrizzleGuildRuleStore implements GuildRuleStore {
  readonly #handle: DbHandle;
  readonly #options: GuildRuleStoreOptions;

  constructor(handle: DbHandle, options: GuildRuleStoreOptions = {}) {
    this.#handle = handle;
    this.#options = options;
  }

  /**
   * The query the worker runs on every dispatch.
   *
   * `trigger_event` is a generated column with `(guild_id, trigger_event)`
   * indexed, so this is one index probe rather than a scan with a JSONB
   * predicate. Cron rules sort into the NULLs and are never candidates.
   *
   * Ordered even though `RuleEngine.evaluate` sorts again: an unordered read
   * makes a test that asserts on the store's output depend on Postgres's
   * heap order, and the sort costs nothing on an index-ordered scan of a
   * handful of rows.
   */
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

    // A null `trigger_event` means "not an event rule", which for a trigger that
    // parsed can only be cron — but a row whose trigger is malformed is also
    // null, and it must not be scheduled. `#parse` rejects those; this filter is
    // what makes the remaining narrowing true rather than assumed.
    return this.#parse(found).filter((rule) => rule.trigger.kind === 'cron');
  }

  /**
   * Seed a module's preset rules for one guild.
   *
   * **`ON CONFLICT DO NOTHING`, never an upsert**, and the difference is the
   * whole behaviour of the feature. Seeding runs on `guild.available`, which
   * fires on every gateway reconnect; an upsert would rewrite `enabled` from the
   * manifest each time, so a guild that switched a rung of the escalation ladder
   * off would find it back on within minutes and never be able to say why.
   * Presets therefore establish a default exactly once and the guild owns the row
   * from then on.
   *
   * Validated on the way in as well as on the way out. `ModuleRegistry` does not
   * check `manifest.rules`, and presets are frequently *compiled* from config
   * (`escalationRules(config)`) rather than written out as literals, so an
   * unvalidated write would land a rule that only fails later, at read time, as
   * an `invalid-rule` skip in some other guild's log. An invalid preset is
   * reported and the rest of the module's presets are still seeded — one bad rung
   * must not cost a guild its whole ladder.
   */
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
          // The id is the first thing that fails to parse on a malformed preset,
          // so fall back to the position rather than reporting `undefined`.
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
        // Drizzle serialises jsonb itself; see client.ts on double-encoding.
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
      .onConflictDoNothing({ target: rules.id })
      .returning({ id: rules.id });

    return inserted.length;
  }

  /**
   * Validate every row on read (I5's argument, applied to rules).
   *
   * `RuleEngine.evaluate` parses too, and reports a row it cannot read as an
   * `invalid-rule` outcome. This is not that check duplicated: a row that fails
   * here never reaches the engine at all, so it cannot become an outcome
   * attributed to a rule whose id was itself part of what failed to parse. The
   * engine's copy stays as the guarantee for a caller that did not come through
   * a store.
   */
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
