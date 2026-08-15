import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { RuleDefinition } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/client.ts';
import {
  DrizzleGuildRuleStore,
  guildRuleRowId,
  type InvalidRuleContext,
  PRESET_CREATED_BY,
} from '../src/guild-rule-store.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds, rules } from '../src/schema/index.ts';
import { rows } from './helpers.ts';

/**
 * The store that finally reads and writes §6's `rules`.
 *
 * Against real Postgres because the two behaviours worth asserting are both the
 * database's: `trigger_event` is a generated column, so "this guild's rules for
 * event X" is a claim about an expression nothing in TypeScript evaluates; and
 * `ON CONFLICT DO NOTHING` is what makes re-seeding on every gateway reconnect
 * safe, which a fake would simply agree with.
 */

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const CHANNEL = '500000000000000001';
const ROLE = '700000000000000001';

/** Every rule the store reports as unreadable, in the order it reported them. */
let reported: Array<{ context: InvalidRuleContext; detail: string }> = [];

function store(): DrizzleGuildRuleStore {
  return new DrizzleGuildRuleStore(handle, {
    onInvalidRule: (context, detail) => reported.push({ context, detail }),
  });
}

const escalate: RuleDefinition = {
  id: 'escalate-at-3',
  trigger: { kind: 'event', event: 'moderation.warned' },
  conditions: [{ kind: 'rate-over-window', limit: 3, window: '24h' }],
  actions: [{ kind: 'timeout', duration: '1h', reason: 'Third warning' }],
  enabled: true,
  priority: 10,
};

const autorole: RuleDefinition = {
  id: 'grant-member',
  trigger: { kind: 'event', event: 'member.joined' },
  conditions: [],
  actions: [{ kind: 'add_role', payload: { roleId: ROLE } }],
  enabled: true,
  priority: 0,
};

const nightly: RuleDefinition = {
  id: 'nightly-sweep',
  trigger: { kind: 'cron', cron: '0 3 * * *', timezone: 'America/New_York' },
  conditions: [],
  actions: [{ kind: 'send', payload: { channelId: CHANNEL, content: 'Nightly sweep ran.' } }],
  enabled: true,
  priority: 0,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  reported = [];
  await handle.client`delete from rules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'someone else' },
  ]);
});

describe('seedPresets', () => {
  test('writes one row per preset, keyed by guild, module and rule', async () => {
    expect(await store().seedPresets(GUILD, 'cases', [escalate])).toBe(1);

    const stored = await rows<{ id: string; created_by: string | null }>(
      handle.client`select id, created_by from rules`,
    );
    expect(stored).toEqual([
      { id: guildRuleRowId(GUILD, 'cases', 'escalate-at-3'), created_by: PRESET_CREATED_BY },
    ]);
  });

  /**
   * The single most important property in this file.
   *
   * Seeding runs on `guild.available`, which fires on every gateway reconnect. An
   * upsert would rewrite `enabled` from the manifest each time, so a guild that
   * switched a rung off would find it back on within hours, silently, with the
   * dashboard showing a value nobody chose.
   */
  test('a preset a guild disabled stays disabled across re-seeding', async () => {
    await store().seedPresets(GUILD, 'cases', [escalate]);

    const rowId = guildRuleRowId(GUILD, 'cases', 'escalate-at-3');
    await handle.db.update(rules).set({ enabled: false }).where(eq(rules.id, rowId));

    // Every reconnect for the rest of the deployment's life.
    expect(await store().seedPresets(GUILD, 'cases', [escalate])).toBe(0);
    expect(await store().seedPresets(GUILD, 'cases', [escalate])).toBe(0);

    const [stored] = await handle.db.select().from(rules).where(eq(rules.id, rowId));
    expect(stored?.enabled).toBe(false);
  });

  /** Nor may it overwrite an edit — the guild owns the row once it exists. */
  test('re-seeding does not overwrite a guild’s edits to a preset', async () => {
    await store().seedPresets(GUILD, 'cases', [escalate]);

    const rowId = guildRuleRowId(GUILD, 'cases', 'escalate-at-3');
    await handle.db
      .update(rules)
      .set({ actions: [{ kind: 'kick', reason: 'Third warning' }], priority: 99 })
      .where(eq(rules.id, rowId));

    await store().seedPresets(GUILD, 'cases', [escalate]);

    const [stored] = await handle.db.select().from(rules).where(eq(rules.id, rowId));
    expect(stored?.actions).toEqual([{ kind: 'kick', reason: 'Third warning' }]);
    expect(stored?.priority).toBe(99);
  });

  test('two guilds get their own row for the same preset', async () => {
    await store().seedPresets(GUILD, 'cases', [escalate]);
    expect(await store().seedPresets(OTHER_GUILD, 'cases', [escalate])).toBe(1);

    expect(await store().listForEvent(GUILD, 'moderation.warned')).toHaveLength(1);
    expect(await store().listForEvent(OTHER_GUILD, 'moderation.warned')).toHaveLength(1);
  });

  /**
   * `ModuleRegistry` does not validate `manifest.rules`, and presets are often
   * compiled from config rather than written as literals. A bad one must not cost
   * the guild the rest of the module's ladder.
   */
  test('an invalid preset is reported and the rest are still seeded', async () => {
    const broken = {
      ...escalate,
      id: 'escalate-at-5',
      // Two rate conditions share one counter, which `ruleDefinitionSchema`
      // refuses outright rather than papering over.
      conditions: [
        { kind: 'rate-over-window', limit: 5, window: '24h' },
        { kind: 'rate-over-window', limit: 9, window: '1h' },
      ],
    } as RuleDefinition;

    expect(await store().seedPresets(GUILD, 'cases', [escalate, broken])).toBe(1);

    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toEqual({
      guildId: GUILD,
      moduleId: 'cases',
      ruleId: 'escalate-at-5',
      source: 'preset',
    });
    expect(reported[0]?.detail).toContain('at most one rate-over-window');
  });

  test('seeding nothing writes nothing and costs no statement', async () => {
    expect(await store().seedPresets(GUILD, 'cases', [])).toBe(0);
    expect(await rows(handle.client`select id from rules`)).toEqual([]);
  });
});

describe('listForEvent', () => {
  beforeEach(async () => {
    await store().seedPresets(GUILD, 'cases', [escalate, nightly]);
    await store().seedPresets(GUILD, 'autorole', [autorole]);
    await store().seedPresets(OTHER_GUILD, 'cases', [escalate]);
  });

  /**
   * The rule's own id comes back, not the composite primary key. The engine
   * builds the rate-window key (`moduleId:ruleId`) and every idempotency key from
   * it, and a module's stable name for a rung — `escalate-at-3` — is what has to
   * appear there for a stored override to be matchable to the preset it came
   * from.
   */
  test('returns the rule under the id its module declared', async () => {
    const [found] = await store().listForEvent(GUILD, 'moderation.warned');

    expect(found?.id).toBe('escalate-at-3');
    expect(found?.guildId).toBe(GUILD);
    expect(found?.moduleId).toBe('cases');
    expect(found?.trigger).toEqual({ kind: 'event', event: 'moderation.warned' });
    expect(found?.conditions).toEqual(escalate.conditions);
    expect(found?.actions).toEqual(escalate.actions);
  });

  test('never returns another guild’s rules', async () => {
    const found = await store().listForEvent(OTHER_GUILD, 'member.joined');

    expect(found).toEqual([]);
  });

  /** A cron rule sorts into the generated column's NULLs, so it is never a candidate. */
  test('never returns a cron rule, whatever the event', async () => {
    for (const type of ['moderation.warned', 'member.joined'] as const) {
      const found = await store().listForEvent(GUILD, type);
      expect(found.every((r) => r.trigger.kind === 'event')).toBe(true);
    }
  });

  test('orders by priority, so two rules on one event run in a fixed order', async () => {
    await handle.db.insert(rules).values({
      id: guildRuleRowId(GUILD, 'cases', 'escalate-at-5'),
      guildId: GUILD,
      moduleId: 'cases',
      trigger: { kind: 'event', event: 'moderation.warned' },
      conditions: [],
      actions: [{ kind: 'kick' }],
      enabled: true,
      priority: 5,
    });

    const found = await store().listForEvent(GUILD, 'moderation.warned');

    expect(found.map((r) => r.id)).toEqual(['escalate-at-5', 'escalate-at-3']);
  });

  /**
   * I5's argument, applied to rules: "it came from our own table" is not a
   * guarantee of shape, because an older build may have written it. A row that
   * cannot be read is skipped and named rather than handed to the engine, so it
   * cannot become an outcome attributed to a rule whose id was part of what
   * failed to parse.
   */
  test('a row that no longer parses is reported and left out', async () => {
    await handle.client`
      insert into rules (id, guild_id, module_id, trigger, conditions, actions, priority)
      values (
        ${guildRuleRowId(GUILD, 'cases', 'no-actions')}, ${GUILD}, 'cases',
        '{"kind":"event","event":"moderation.warned"}'::jsonb, '[]'::jsonb, '[]'::jsonb, 0
      )
    `;

    const found = await store().listForEvent(GUILD, 'moderation.warned');

    expect(found.map((r) => r.id)).toEqual(['escalate-at-3']);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context.ruleId).toBe('no-actions');
    expect(reported[0]?.context.source).toBe('stored');
  });
});

describe('listCron', () => {
  beforeEach(async () => {
    await store().seedPresets(GUILD, 'cases', [escalate, nightly]);
  });

  test('returns the cron rules and nothing else', async () => {
    const found = await store().listCron(GUILD);

    expect(found.map((r) => r.id)).toEqual(['nightly-sweep']);
    expect(found[0]?.trigger).toEqual({
      kind: 'cron',
      cron: '0 3 * * *',
      timezone: 'America/New_York',
    });
  });

  /**
   * A malformed trigger also derives a NULL `trigger_event`, so it arrives on
   * this query. It must not be scheduled — a rule nobody can read has no
   * schedule that could be correct.
   */
  test('a row with an unreadable trigger is reported, not scheduled', async () => {
    await handle.client`
      insert into rules (id, guild_id, module_id, trigger, actions)
      values ('broken', ${GUILD}, 'cases', '{"kind":"whenever"}'::jsonb, '[{"kind":"kick"}]'::jsonb)
    `;

    const found = await store().listCron(GUILD);

    expect(found.map((r) => r.id)).toEqual(['nightly-sweep']);
    expect(reported.map((r) => r.context.ruleId)).toEqual(['broken']);
  });

  test('never returns another guild’s cron rules', async () => {
    expect(await store().listCron(OTHER_GUILD)).toEqual([]);
  });
});
