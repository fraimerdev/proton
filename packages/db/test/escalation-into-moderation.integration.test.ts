import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';

// runMigrations() already ran 0032 on empty tables; re-running it on seeded rows is the test.
const MIGRATION = `${import.meta.dir}/../drizzle/0032_escalation_into_moderation.sql`;

async function move(): Promise<void> {
  const sql = await Bun.file(MIGRATION).text();

  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await handle.client.unsafe(trimmed);
  }
}

async function seedModule(moduleId: string, config: unknown, enabled = true, schemaVersion = 1) {
  await handle.client`
    insert into guild_modules (guild_id, module_id, enabled, config, schema_version)
    values (${GUILD}, ${moduleId}, ${enabled}, ${JSON.stringify(config)}::jsonb, ${schemaVersion})
  `;
}

async function seedRule(
  moduleId: string,
  ruleId: string,
  overrides: {
    enabled?: boolean;
    priority?: number;
    createdBy?: string | null;
    actions?: unknown;
  } = {},
) {
  const atWarnings = Number(ruleId.replace('escalate-at-', '')) || 3;

  await handle.client`
    insert into rules (id, guild_id, module_id, trigger, conditions, actions, enabled, priority, created_by)
    values (
      ${`${GUILD}:${moduleId}:${ruleId}`},
      ${GUILD},
      ${moduleId},
      ${JSON.stringify({ kind: 'event', event: 'moderation.warned' })}::jsonb,
      ${JSON.stringify([{ kind: 'rate-over-window', limit: atWarnings, window: '30d' }])}::jsonb,
      ${JSON.stringify(
        overrides.actions ?? [
          {
            kind: 'timeout',
            reason: `Warning ${atWarnings} within 30d — automatic escalation`,
            duration: '1h',
          },
        ],
      )}::jsonb,
      ${overrides.enabled ?? true},
      ${overrides.priority ?? 0},
      ${overrides.createdBy === undefined ? 'proton:preset' : overrides.createdBy}
    )
  `;
}

async function moduleRow(moduleId: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await handle.client`
    select * from guild_modules where guild_id = ${GUILD} and module_id = ${moduleId}
  `) as unknown as Array<Record<string, unknown>>;

  return rows[0];
}

async function allRules(): Promise<Array<Record<string, unknown>>> {
  return (await handle.client`
    select * from rules order by id
  `) as unknown as Array<Record<string, unknown>>;
}

const LADDER = [
  { atWarnings: 2, action: 'timeout', duration: '10m' },
  { atWarnings: 4, action: 'kick' },
  { atWarnings: 6, action: 'ban' },
];

const CASES = { enabled: true, historyLimit: 10, escalationWindow: '7d', escalationLadder: LADDER };

const MODERATION = {
  enabled: true,
  requireReason: false,
  publicReplies: false,
  defaultTimeoutDuration: '1h',
  defaultBanDeleteDays: 0,
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
  await handle.client`delete from rules`;
  await handle.client`delete from guild_modules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

describe('0032_escalation_into_moderation', () => {
  test('the ladder and window move onto the moderation row beside its own settings', async () => {
    await seedModule('cases', CASES);
    await seedModule('moderation', MODERATION);

    await move();

    expect((await moduleRow('moderation'))?.config).toEqual({
      ...MODERATION,
      escalationWindow: '7d',
      escalationLadder: LADDER,
    });
  });

  test('the cases row keeps its own settings and loses the escalation keys', async () => {
    await seedModule('cases', CASES);

    await move();

    expect((await moduleRow('cases'))?.config).toEqual({ enabled: true, historyLimit: 10 });
  });

  test('both rows are stamped with the new schema version', async () => {
    await seedModule('cases', CASES);
    await seedModule('moderation', MODERATION);

    await move();

    expect((await moduleRow('cases'))?.schema_version).toBe(2);
    expect((await moduleRow('moderation'))?.schema_version).toBe(2);
  });

  test('a guild with no moderation row gets one, switched off, carrying only the ladder', async () => {
    await seedModule('cases', CASES);

    await move();

    const row = await moduleRow('moderation');

    expect(row?.enabled).toBe(false);
    expect(row?.config).toEqual({
      enabled: false,
      escalationWindow: '7d',
      escalationLadder: LADDER,
    });
  });

  test('a cases row without escalation keys invents nothing', async () => {
    await seedModule('cases', { enabled: true, historyLimit: 5 });
    await seedModule('moderation', { enabled: true, requireReason: true });

    await move();

    expect((await moduleRow('moderation'))?.config).toEqual({ enabled: true, requireReason: true });
    expect((await moduleRow('cases'))?.config).toEqual({ enabled: true, historyLimit: 5 });
  });

  test('a guild with neither escalation keys nor a moderation row gets no moderation row', async () => {
    await seedModule('cases', { enabled: true, historyLimit: 5 });

    await move();

    expect(await moduleRow('moderation')).toBeUndefined();
  });

  test('a stored null is not carried', async () => {
    await seedModule('cases', { ...CASES, escalationWindow: null });
    await seedModule('moderation', MODERATION);

    await move();

    const config = (await moduleRow('moderation'))?.config as Record<string, unknown>;

    expect(config).not.toHaveProperty('escalationWindow');
    expect(config.escalationLadder).toEqual(LADDER);
  });

  test('a module that was switched off stays off', async () => {
    await seedModule('cases', CASES, false);
    await seedModule('moderation', { enabled: false }, false);

    await move();

    expect((await moduleRow('moderation'))?.enabled).toBe(false);
    expect((await moduleRow('cases'))?.enabled).toBe(false);
  });

  test('every rung moves to the moderation module with its row intact', async () => {
    await seedModule('cases', CASES);
    await seedRule('cases', 'escalate-at-2', { priority: 0 });
    await seedRule('cases', 'escalate-at-4', { priority: 10, createdBy: null });

    const before = await allRules();
    await move();
    const after = await allRules();

    expect(after.map((r) => r.id)).toEqual([
      `${GUILD}:moderation:escalate-at-2`,
      `${GUILD}:moderation:escalate-at-4`,
    ]);

    for (const [index, row] of after.entries()) {
      expect(row).toEqual({
        ...(before[index] as Record<string, unknown>),
        id: row.id,
        module_id: 'moderation',
      });
    }
  });

  test('a rung the guild switched off stays off', async () => {
    await seedModule('cases', CASES);
    await seedRule('cases', 'escalate-at-4', { enabled: false });

    await move();

    const [row] = await allRules();

    expect(row?.id).toBe(`${GUILD}:moderation:escalate-at-4`);
    expect(row?.enabled).toBe(false);
  });

  test('a moderation rule already holding the id is kept, and the cases rung is dropped', async () => {
    const held = [{ kind: 'timeout', reason: 'already here', duration: '2h' }];
    await seedRule('moderation', 'escalate-at-3', { actions: held });
    await seedRule('cases', 'escalate-at-3', { enabled: false, actions: [{ kind: 'ban' }] });
    await seedRule('cases', 'escalate-at-5');

    await move();

    const rows = await allRules();

    expect(rows.map((r) => r.id)).toEqual([
      `${GUILD}:moderation:escalate-at-3`,
      `${GUILD}:moderation:escalate-at-5`,
    ]);
    expect(rows[0]?.actions).toEqual(held);
    expect(rows[0]?.enabled).toBe(true);
  });

  test('a rung the old seeder put back after the guild removed it does not move', async () => {
    await seedModule('cases', CASES);
    await seedRule('cases', 'escalate-at-2');
    await seedRule('cases', 'escalate-at-3');
    await seedRule('cases', 'escalate-at-4');
    await seedRule('cases', 'escalate-at-5');

    await move();

    expect((await allRules()).map((r) => r.id)).toEqual([
      `${GUILD}:moderation:escalate-at-2`,
      `${GUILD}:moderation:escalate-at-4`,
    ]);
  });

  test('a guild that never saved a ladder keeps the shipped rungs and loses any other', async () => {
    await seedRule('cases', 'escalate-at-3');
    await seedRule('cases', 'escalate-at-4');
    await seedRule('cases', 'escalate-at-5');

    await move();

    expect((await allRules()).map((r) => r.id)).toEqual([
      `${GUILD}:moderation:escalate-at-3`,
      `${GUILD}:moderation:escalate-at-5`,
    ]);
  });

  test('a moderation row without a ladder is judged against the shipped one', async () => {
    await seedModule('moderation', MODERATION);
    await seedRule('moderation', 'escalate-at-3');
    await seedRule('moderation', 'escalate-at-6');

    await move();

    expect((await allRules()).map((r) => r.id)).toEqual([`${GUILD}:moderation:escalate-at-3`]);
  });

  test('an emptied ladder keeps no rung at all', async () => {
    await seedModule('cases', { ...CASES, escalationLadder: [] });
    await seedRule('cases', 'escalate-at-3');

    await move();

    expect(await allRules()).toEqual([]);
  });

  test('another module’s rules are never judged against the ladder', async () => {
    await seedModule('cases', CASES);
    await seedRule('automod', 'escalate-at-9');
    await seedRule('moderation', 'ban-spammers');

    await move();

    expect((await allRules()).map((r) => r.id)).toEqual([
      `${GUILD}:automod:escalate-at-9`,
      `${GUILD}:moderation:ban-spammers`,
    ]);
  });

  test('the moved rules are still found by their trigger event', async () => {
    await seedRule('cases', 'escalate-at-3');

    await move();

    const found = (await handle.client`
      select id from rules where guild_id = ${GUILD} and trigger_event = 'moderation.warned'
    `) as unknown as Array<{ id: string }>;

    expect(found.map((r) => r.id)).toEqual([`${GUILD}:moderation:escalate-at-3`]);
  });

  test('a cases rule that is not an escalation rung is left alone', async () => {
    await seedRule('cases', 'something-else');
    await seedRule('automod', 'escalate-at-3');

    const before = await allRules();
    await move();

    expect(await allRules()).toEqual(before);
  });

  test('another module is left alone', async () => {
    await seedModule('automod', { enabled: true, escalationLadder: ['not ours'] });

    await move();

    const row = await moduleRow('automod');

    expect(row?.config).toEqual({ enabled: true, escalationLadder: ['not ours'] });
    expect(row?.schema_version).toBe(1);
  });

  test('running it twice changes nothing the second time', async () => {
    await seedModule('cases', CASES);
    await seedRule('cases', 'escalate-at-2');
    await seedRule('cases', 'escalate-at-4', { enabled: false, priority: 10 });

    await move();
    const once = {
      moderation: await moduleRow('moderation'),
      cases: await moduleRow('cases'),
      rules: await allRules(),
    };
    await move();

    expect(await moduleRow('moderation')).toEqual(once.moderation as Record<string, unknown>);
    expect(await moduleRow('cases')).toEqual(once.cases as Record<string, unknown>);
    expect(await allRules()).toEqual(once.rules);
  });
});
