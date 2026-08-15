import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { guildRuleSchema } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds, rules } from '../src/schema/index.ts';
import { firstRow, rows } from './helpers.ts';

/**
 * `rules.trigger` holds a discriminated union, so the storage question is
 * whether both arms survive the round trip — insert, select, and back through
 * `guildRuleSchema`, the same parse the engine performs on load.
 *
 * The cron arm is the one that motivated migration 0003. As a text column
 * `trigger` could hold the event arm's discriminator and nothing else, so a cron
 * rule either lost its expression and timezone or had to be smuggled through in
 * some encoding `ruleTriggerSchema` does not describe.
 */

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';
const MOD_CHANNEL = '500000000000000000';
const ALERT_ROLE = '600000000000000000';

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
  await handle.client`delete from rules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

/**
 * Both rules carry conditions and actions as well as a trigger, so the round
 * trip exercises every JSONB column on the row rather than the one under test.
 */
const eventRule = {
  id: 'invite-spam-timeout',
  guildId: GUILD,
  moduleId: 'moderation',
  trigger: { kind: 'event', event: 'message.created' },
  conditions: [
    { kind: 'content-pattern', pattern: 'discord\\.gg/', mode: 'regex' },
    { kind: 'rate-over-window', limit: 3, window: '10s', scope: 'actor' },
  ],
  actions: [{ kind: 'timeout', reason: 'Invite spam.', duration: '30m' }],
  enabled: true,
  priority: 10,
} satisfies typeof rules.$inferInsert;

/**
 * `cron` and `timezone` are the fields a text column had nowhere to put, and
 * `enabled: false` is here because a preset may ship switched off — none of it
 * is allowed to come back changed.
 */
const cronRule = {
  id: 'nightly-mute-sweep',
  guildId: GUILD,
  moduleId: 'moderation',
  trigger: { kind: 'cron', cron: '0 3 * * *', timezone: 'America/New_York' },
  conditions: [{ kind: 'role-has', roleIds: [ALERT_ROLE], match: 'any' }],
  actions: [{ kind: 'send', payload: { channelId: MOD_CHANNEL, content: 'Nightly sweep ran.' } }],
  enabled: false,
  priority: 0,
} satisfies typeof rules.$inferInsert;

const storedRule = async (id: string) =>
  firstRow<typeof rules.$inferSelect>(handle.db.select().from(rules).where(eq(rules.id, id)));

describe('rules.trigger round trip', () => {
  test('a cron trigger survives insert -> select -> guildRuleSchema.parse', async () => {
    await handle.db.insert(rules).values(cronRule);

    const parsed = guildRuleSchema.parse(await storedRule(cronRule.id));

    expect(parsed.trigger).toEqual({
      kind: 'cron',
      cron: '0 3 * * *',
      timezone: 'America/New_York',
    });
    expect(parsed.conditions).toEqual(cronRule.conditions);
    expect(parsed.actions).toEqual(cronRule.actions);
    expect(parsed.enabled).toBe(false);
    expect(parsed.guildId).toBe(GUILD);
    expect(parsed.moduleId).toBe('moderation');
  });

  test('an event trigger survives insert -> select -> guildRuleSchema.parse', async () => {
    await handle.db.insert(rules).values(eventRule);

    const parsed = guildRuleSchema.parse(await storedRule(eventRule.id));

    expect(parsed.trigger).toEqual({ kind: 'event', event: 'message.created' });
    expect(parsed.conditions).toEqual(eventRule.conditions);
    expect(parsed.actions).toEqual(eventRule.actions);
    expect(parsed.enabled).toBe(true);
    expect(parsed.priority).toBe(10);
  });

  /**
   * Regression guard for the driver-level double-encoding documented in
   * client.ts: stored as a jsonb *string scalar*, `trigger->>'kind'` returns
   * null, the generated column below is null for every row, and event dispatch
   * quietly matches nothing.
   */
  test('trigger is stored as a jsonb object, not a jsonb string scalar', async () => {
    await handle.db.insert(rules).values([eventRule, cronRule]);

    const found = await rows<{ id: string; type: string; kind: string }>(handle.client`
      select id, jsonb_typeof(trigger) as type, trigger->>'kind' as kind
        from rules order by id
    `);

    expect(found).toEqual([
      { id: eventRule.id, type: 'object', kind: 'event' },
      { id: cronRule.id, type: 'object', kind: 'cron' },
    ]);
  });
});

describe('rules.trigger_event', () => {
  test('is derived for an event rule and null for a cron rule', async () => {
    await handle.db.insert(rules).values([eventRule, cronRule]);

    expect((await storedRule(eventRule.id)).triggerEvent).toBe('message.created');
    expect((await storedRule(cronRule.id)).triggerEvent).toBeNull();
  });

  /**
   * The query the worker runs on every dispatch. The cron rule must not appear
   * in it — not because a later filter drops it, but because it was never a
   * candidate.
   */
  test('answers "this guild\'s rules for event X" without matching cron rules', async () => {
    await handle.db.insert(rules).values([eventRule, cronRule]);

    const matched = await handle.db
      .select()
      .from(rules)
      .where(and(eq(rules.guildId, GUILD), eq(rules.triggerEvent, 'message.created')));

    expect(matched.map((r) => r.id)).toEqual([eventRule.id]);
  });

  /**
   * The property a plain second column could not have. Editing the trigger
   * re-derives the discriminator, so the two can never disagree — there is no
   * write path that updates one and forgets the other.
   */
  test('tracks the trigger when a rule is edited', async () => {
    await handle.db.insert(rules).values(eventRule);

    await handle.db
      .update(rules)
      .set({ trigger: { kind: 'event', event: 'member.joined' } })
      .where(eq(rules.id, eventRule.id));
    expect((await storedRule(eventRule.id)).triggerEvent).toBe('member.joined');

    // Retriggering the same rule on a schedule drops it out of event dispatch.
    await handle.db
      .update(rules)
      .set({ trigger: { kind: 'cron', cron: '*/5 * * * *' } })
      .where(eq(rules.id, eventRule.id));
    expect((await storedRule(eventRule.id)).triggerEvent).toBeNull();
  });

  /**
   * Why the expression tests `kind` rather than reading `->> 'event'` outright.
   * Nothing in the database compels a writer to go through `ruleTriggerSchema`,
   * and an unguarded expression would enrol this row in event dispatch on the
   * strength of a key its own discriminator says is not there — a cron rule
   * firing on every message.
   */
  test('ignores an event key on a cron trigger', async () => {
    const smuggled = JSON.stringify({ kind: 'cron', cron: '0 3 * * *', event: 'message.created' });
    await handle.client`
      insert into rules (id, guild_id, module_id, trigger, actions)
      values ('smuggled', ${GUILD}, 'moderation', ${smuggled}::jsonb, '[]'::jsonb)
    `;

    expect((await storedRule('smuggled')).triggerEvent).toBeNull();
  });

  test('is generated by Postgres, so it cannot be written directly', async () => {
    // Executed inside an async function rather than handed to `.rejects`
    // directly — see the note in migrations.integration.test.ts about thenables.
    const forge = async () => {
      await handle.client`
        insert into rules (id, guild_id, module_id, trigger, trigger_event)
        values ('forged', ${GUILD}, 'moderation', '{"kind":"cron","cron":"0 3 * * *"}'::jsonb, 'message.created')
      `;
    };

    await expect(forge()).rejects.toThrow();
  });
});

describe('rules indexes', () => {
  test('the dispatch lookup is indexed on (guild_id, trigger_event)', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'rules' and indexname = 'rules_guild_trigger_event_idx'
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.indexdef).toContain('(guild_id, trigger_event)');
  });
});
