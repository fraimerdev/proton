import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { cases, guilds } from '../src/schema/index.ts';
import { firstRow, rows } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD_ID = '900000000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  await handle.db.insert(guilds).values({ id: GUILD_ID, name: 'test guild' });
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

async function insertCase(values: typeof cases.$inferInsert): Promise<void> {
  await handle.db.insert(cases).values(values);
}

function newCase(overrides: Partial<typeof cases.$inferInsert> = {}) {
  return {
    id: crypto.randomUUID(),
    guildId: GUILD_ID,
    caseNumber: Math.floor(Math.random() * 1_000_000) + 1000,
    type: 'send',
    moduleId: 'ping',
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  } satisfies typeof cases.$inferInsert;
}

describe('migrations', () => {
  test('apply cleanly and create every PLAN.md §6 core table', async () => {
    const result = await rows<{ table_name: string }>(handle.client`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `);
    const tables = new Set(result.map((r) => r.table_name));

    for (const expected of [
      'guilds',
      'guild_modules',
      'cases',
      'members',
      'rules',
      'scheduled_actions',
      'audit_trail',
      'backups',
      'entitlements',
      'blocked_members',
      'appeals',
      'appeal_answers',
      'afk_statuses',
      'afk_pings',
      'xp_grants',
      'achievement_seen',
      'achievement_activity',
      'achievement_progress',
      'achievement_members',
      'achievement_state',
      'achievement_periods',
      'achievement_unlocks',
      'achievement_rewards',
      'achievement_member_facts',
      'achievement_badges',
      'guild_commands',
      'guild_command_registrations',
      'application_form_versions',
      'applications',
      'application_events',
      'application_thread',
      'application_notes',
      'application_votes',
      'application_effects',
      'application_role_grants',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test('are idempotent on re-run', async () => {
    await runMigrations(handle);

    const row = await firstRow<{ n: number }>(handle.client`select count(*)::int as n from guilds`);
    expect(row.n).toBe(1);
  });
});

describe('cases constraints', () => {
  test('UNIQUE(idempotency_key) rejects a duplicate — the I4 backstop', async () => {
    const key = crypto.randomUUID();
    await insertCase(newCase({ idempotencyKey: key }));

    await expect(insertCase(newCase({ idempotencyKey: key }))).rejects.toThrow();
  });

  test('UNIQUE(guild_id, case_number) rejects a duplicate case number', async () => {
    const caseNumber = 4242;
    await insertCase(newCase({ caseNumber }));

    await expect(insertCase(newCase({ caseNumber }))).rejects.toThrow();
  });

  test('the same case number is allowed in a different guild', async () => {
    const other = '900000000000000002';
    await handle.db.insert(guilds).values({ id: other, name: 'other guild' });

    await insertCase(newCase({ caseNumber: 7 }));
    await insertCase(newCase({ guildId: other, caseNumber: 7 }));

    const row = await firstRow<{ n: number }>(
      handle.client`select count(*)::int as n from cases where case_number = 7`,
    );
    expect(row.n).toBe(2);
  });
});

describe('cases indexes', () => {
  test('the auto-reversal sweeper index is partial, not a full index', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'cases' and indexname = 'cases_pending_expiry_idx'
    `);

    expect(found).toHaveLength(1);
    const def = found[0]?.indexdef ?? '';

    expect(def).toContain('WHERE');
    expect(def).toContain('expires_at IS NOT NULL');
    expect(def).toContain('reverted_at IS NULL');
  });

  test('the per-target history index exists and is descending by created_at', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'cases' and indexname = 'cases_guild_target_created_idx'
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.indexdef).toContain('created_at DESC');
  });
});

describe('blocked_members indexes', () => {
  test('the idempotency index is NOT partial, so a redelivery cannot re-block a lifted member', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'blocked_members' and indexname = 'blocked_members_idempotency_key_uq'
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.indexdef).not.toContain('WHERE');
  });

  test('the live index is partial, so a member can be blocked again after a lift', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'blocked_members' and indexname = 'blocked_members_live_uq'
    `);

    expect(found).toHaveLength(1);

    const def = found[0]?.indexdef ?? '';

    expect(def).toContain('WHERE');
    expect(def).toContain('lifted_at IS NULL');
  });
});

describe('achievements indexes', () => {
  async function indexdef(table: string, name: string): Promise<string> {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes where tablename = ${table} and indexname = ${name}
    `);

    expect(found).toHaveLength(1);
    return found[0]?.indexdef ?? '';
  }

  test('one open period per achievement is enforced by a partial unique index', async () => {
    const def = await indexdef('achievement_periods', 'achievement_periods_open_uq');

    expect(def).toContain('UNIQUE');
    expect(def).toContain('(guild_id, achievement_id)');
    expect(def).toContain('WHERE');
    expect(def).toContain('ended_at IS NULL');
  });

  test('a second open period for the same achievement is refused, a closed one is not', async () => {
    const period = (startedAt: string, endedAt: string | null) => handle.client`
      insert into achievement_periods (guild_id, achievement_id, started_at, ended_at)
      values (${GUILD_ID}, 'chatterbox', ${startedAt}, ${endedAt})`;

    await period('2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    await period('2026-09-03T00:00:00.000Z', null);

    await expect(Promise.resolve(period('2026-09-04T00:00:00.000Z', null))).rejects.toThrow();
  });

  test('the sweep’s unlock indexes are partial', async () => {
    expect(
      await indexdef('achievement_unlocks', 'achievement_unlocks_pending_announce_idx'),
    ).toContain("WHERE (announce_status = 'pending'::text)");
    expect(await indexdef('achievement_unlocks', 'achievement_unlocks_unpublished_idx')).toContain(
      'WHERE (published_at IS NULL)',
    );
    expect(await indexdef('achievement_seen', 'achievement_seen_group_idx')).toContain(
      'WHERE (group_key IS NOT NULL)',
    );
  });

  test('every achievement table cascades from its server', async () => {
    const found = await rows<{ table_name: string; delete_rule: string }>(handle.client`
      select tc.table_name, rc.delete_rule
        from information_schema.table_constraints tc
        join information_schema.referential_constraints rc
          on rc.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY' and left(tc.table_name, 12) = 'achievement_'
       order by tc.table_name
    `);

    expect(found).toHaveLength(10);
    expect(found.every((row) => row.delete_rule === 'CASCADE')).toBe(true);
  });
});

describe('command tables', () => {
  const COMMANDS_GUILD = '900000000000000040';

  test('both cascade from their server', async () => {
    const found = await rows<{ table_name: string; delete_rule: string }>(handle.client`
      select tc.table_name, rc.delete_rule
        from information_schema.table_constraints tc
        join information_schema.referential_constraints rc
          on rc.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY'
         and tc.table_name in ('guild_commands', 'guild_command_registrations')
    `);

    expect(found.map((row) => row.table_name).sort()).toEqual([
      'guild_command_registrations',
      'guild_commands',
    ]);
    expect(found.every((row) => row.delete_rule === 'CASCADE')).toBe(true);
  });

  test('a row with only its keys reads as nothing customized and nothing registered', async () => {
    await handle.db.insert(guilds).values({ id: COMMANDS_GUILD, name: 'commands guild' });
    await handle.client`
      insert into guild_commands (guild_id, command_key) values (${COMMANDS_GUILD}, 'ban')`;
    await handle.client`
      insert into guild_command_registrations (guild_id, scope) values (${COMMANDS_GUILD}, 'guild')`;

    expect(
      await firstRow<Record<string, unknown>>(handle.client`
        select enabled, name, description, option_descriptions, private_reply, schema_version
          from guild_commands where guild_id = ${COMMANDS_GUILD}`),
    ).toEqual({
      enabled: true,
      name: null,
      description: null,
      option_descriptions: {},
      private_reply: null,
      schema_version: 1,
    });

    expect(
      await firstRow<Record<string, unknown>>(handle.client`
        select definition_hash, commands, id_history, failure, lost_permissions
          from guild_command_registrations where guild_id = ${COMMANDS_GUILD}`),
    ).toEqual({
      definition_hash: null,
      commands: [],
      id_history: {},
      failure: null,
      lost_permissions: null,
    });
  });

  test('deleting the server deletes its command rows', async () => {
    await handle.client`delete from guilds where id = ${COMMANDS_GUILD}`;

    expect(
      await firstRow<{ commands: number; registrations: number }>(handle.client`
        select (select count(*)::int from guild_commands where guild_id = ${COMMANDS_GUILD})
                 as commands,
               (select count(*)::int from guild_command_registrations
                 where guild_id = ${COMMANDS_GUILD}) as registrations`),
    ).toEqual({ commands: 0, registrations: 0 });
  });
});

describe('applications tables', () => {
  const APPLICATIONS_GUILD = '900000000000000041';

  async function indexdef(table: string, name: string): Promise<string> {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes where tablename = ${table} and indexname = ${name}
    `);

    expect(found).toHaveLength(1);
    return found[0]?.indexdef ?? '';
  }

  test('one draft per member and form is enforced by a partial unique index', async () => {
    const def = await indexdef('applications', 'applications_one_draft_uq');

    expect(def).toContain('UNIQUE');
    expect(def).toContain('(guild_id, form_id, applicant_id)');
    expect(def).toContain("WHERE (status = 'draft'::text)");
  });

  test('reference numbers are unique per server once assigned', async () => {
    const def = await indexdef('applications', 'applications_guild_number_uq');

    expect(def).toContain('UNIQUE');
    expect(def).toContain('(guild_id, number)');
    expect(def).toContain('WHERE (number IS NOT NULL)');
  });

  test('the queue and sweep indexes are the declared shape', async () => {
    expect(await indexdef('applications', 'applications_guild_status_submitted_idx')).toContain(
      'submitted_at DESC',
    );
    expect(await indexdef('applications', 'applications_draft_expiry_idx')).toContain(
      "WHERE (status = 'draft'::text)",
    );
    expect(await indexdef('applications', 'applications_content_purge_idx')).toContain(
      'WHERE (content_purged_at IS NULL)',
    );
    expect(
      await indexdef('application_effects', 'application_effects_application_key_uq'),
    ).toContain('UNIQUE');
  });

  test('a ticket opened for another module is unique while it is open', async () => {
    const def = await indexdef('tickets', 'tickets_source_open_uq');

    expect(def).toContain('UNIQUE');
    expect(def).toContain('(guild_id, source_module, source_ref)');
    expect(def).toContain('source_ref IS NOT NULL');
    expect(def).toContain("status = 'open'::text");

    const columns = await rows<{ column_name: string; is_nullable: string }>(handle.client`
      select column_name, is_nullable from information_schema.columns
       where table_name = 'tickets' and column_name in ('source_module', 'source_ref')
       order by column_name
    `);
    expect(columns).toEqual([
      { column_name: 'source_module', is_nullable: 'YES' },
      { column_name: 'source_ref', is_nullable: 'YES' },
    ]);
  });

  test('every application table cascades from its server', async () => {
    const found = await rows<{ table_name: string; delete_rule: string }>(handle.client`
      select tc.table_name, rc.delete_rule
        from information_schema.table_constraints tc
        join information_schema.referential_constraints rc
          on rc.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY' and tc.table_name like 'application%'
       order by tc.table_name
    `);

    expect(found).toHaveLength(15);
    expect(found.every((row) => row.delete_rule === 'CASCADE')).toBe(true);
  });

  test('a bare application row reads as an unsubmitted draft, and the server takes it along', async () => {
    await handle.db.insert(guilds).values({ id: APPLICATIONS_GUILD, name: 'applications guild' });
    await handle.client`
      insert into application_form_versions (id, guild_id, form_id, version, snapshot, published_by)
      values ('v1', ${APPLICATIONS_GUILD}, 'mods', 1, '{}'::jsonb, '100000000000000001')`;
    await handle.client`
      insert into applications (id, guild_id, form_id, version_id, applicant_id)
      values ('a1', ${APPLICATIONS_GUILD}, 'mods', 'v1', '400000000000000001')`;

    expect(
      await firstRow<Record<string, unknown>>(handle.client`
        select number, status, revision, draft, step, answers, reopened_count, card_revision
          from applications where id = 'a1'`),
    ).toEqual({
      number: null,
      status: 'draft',
      revision: 0,
      draft: {},
      step: 0,
      answers: null,
      reopened_count: 0,
      card_revision: -1,
    });

    await handle.client`
      insert into application_effects (id, guild_id, application_id, key, kind, trigger, revision)
      values ('e1', ${APPLICATIONS_GUILD}, 'a1', 'card', 'card', 'card', 1)`;

    expect(
      await firstRow<Record<string, unknown>>(handle.client`
        select status, attempts, claim_seq, lease_until, params, result
          from application_effects where id = 'e1'`),
    ).toEqual({
      status: 'pending',
      attempts: 0,
      claim_seq: 0,
      lease_until: null,
      params: {},
      result: {},
    });

    await handle.client`delete from guilds where id = ${APPLICATIONS_GUILD}`;

    expect(
      await firstRow<{ versions: number; applications: number; effects: number }>(handle.client`
        select (select count(*)::int from application_form_versions
                 where guild_id = ${APPLICATIONS_GUILD}) as versions,
               (select count(*)::int from applications
                 where guild_id = ${APPLICATIONS_GUILD}) as applications,
               (select count(*)::int from application_effects
                 where guild_id = ${APPLICATIONS_GUILD}) as effects`),
    ).toEqual({ versions: 0, applications: 0, effects: 0 });
  });
});
