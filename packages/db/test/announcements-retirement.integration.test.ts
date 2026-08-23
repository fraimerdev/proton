import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const ROLE = '600000000000000001';

// 0018 has already run against an empty table by the time runMigrations() returns, so the SQL is
// re-executed against hand-seeded legacy rows. It is the statement itself that is under test.
const MIGRATION = `${import.meta.dir}/../drizzle/0018_announcements_into_messages.sql`;

async function retire(): Promise<void> {
  const sql = await Bun.file(MIGRATION).text();

  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await handle.client.unsafe(trimmed);
  }
}

async function seedModule(moduleId: string, config: unknown, enabled = true) {
  await handle.client`
    insert into guild_modules (guild_id, module_id, enabled, config, schema_version)
    values (${GUILD}, ${moduleId}, ${enabled}, ${JSON.stringify(config)}::jsonb, 4)
  `;
}

async function seedBooking(announcementId: string, runAt = '2026-09-01T09:00:00.000Z') {
  await handle.client`
    insert into scheduled_actions (id, guild_id, run_at, kind, payload, idempotency_key)
    values (
      ${`sa-${announcementId}`},
      ${GUILD},
      ${runAt}::timestamptz,
      'module_job',
      ${JSON.stringify({
        kind: 'module',
        moduleId: 'announcements',
        jobId: 'post',
        guildId: GUILD,
        data: { announcementId, runAt },
      })}::jsonb,
      ${`announcements:post:${GUILD}:${announcementId}`}
    )
  `;
}

async function moduleRow(moduleId: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await handle.client`
    select * from guild_modules where guild_id = ${GUILD} and module_id = ${moduleId}
  `) as unknown as Array<Record<string, unknown>>;

  return rows[0];
}

async function bookings(): Promise<Array<Record<string, unknown>>> {
  return (await handle.client`
    select * from scheduled_actions order by idempotency_key
  `) as unknown as Array<Record<string, unknown>>;
}

function templatesOf(row: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const config = (row?.config ?? {}) as { templates?: Array<Record<string, unknown>> };
  return config.templates ?? [];
}

const WEEKLY = {
  id: 'weekly',
  name: 'Weekly notice',
  channelId: CHANNEL,
  message: 'Stand up at nine.',
  mode: 'repeat',
  at: '2026-09-01T09:00:00.000Z',
  every: '7d',
  pingRoleId: ROLE,
  enabled: true,
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
  await handle.client`delete from scheduled_actions`;
  await handle.client`delete from guild_modules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

describe('0018_announcements_into_messages', () => {
  test('every announcement becomes a scheduled template', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', { enabled: true, templates: [], components: [] });

    await retire();

    const [template] = templatesOf(await moduleRow('messages'));

    expect(template?.name).toBe('weekly');
    expect(template?.content).toBe('Stand up at nine.');
    expect(template?.schedule).toEqual({
      channelId: CHANNEL,
      at: '2026-09-01T09:00:00.000Z',
      mode: 'repeat',
      every: '7d',
      pingRoleId: ROLE,
      enabled: true,
    });
  });

  // The announcement id becomes the template name because it is the natural key every booked row
  // carries. Anything else and the rewritten rows would fire into a template that is not there.
  test('the booked row moves to the messages module, keeping its natural key', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', { enabled: true, templates: [], components: [] });
    await seedBooking('weekly');

    await retire();

    const [booked] = await bookings();
    const payload = booked?.payload as { moduleId: string; data: Record<string, unknown> };

    expect(booked?.idempotency_key).toBe(`messages:post:${GUILD}:weekly`);
    expect(payload.moduleId).toBe('messages');
    expect(payload.data.templateName).toBe('weekly');
    expect(payload.data).not.toHaveProperty('announcementId');
  });

  test('the run it was booked for is untouched, so nothing fires early or twice', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', { enabled: true, templates: [], components: [] });
    await seedBooking('weekly');

    await retire();

    const [booked] = await bookings();
    const payload = booked?.payload as { data: { runAt: string } } | undefined;

    expect(payload?.data.runAt).toBe('2026-09-01T09:00:00.000Z');
    expect(new Date(booked?.run_at as string).toISOString()).toBe('2026-09-01T09:00:00.000Z');
  });

  test('a guild that never had the messages module gets one, switched off', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });

    await retire();

    const row = await moduleRow('messages');

    expect(row?.enabled).toBe(false);
    expect(templatesOf(row)).toHaveLength(1);
  });

  test('templates the guild already had are kept alongside the migrated ones', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', {
      enabled: true,
      templates: [{ name: 'rules', content: 'Be kind.' }],
      components: [],
    });

    await retire();

    expect(templatesOf(await moduleRow('messages')).map((t) => t.name)).toEqual([
      'rules',
      'weekly',
    ]);
  });

  // Two things called `weekly` would make /message post ambiguous, and the template already there
  // is the one the admin last edited.
  test('an announcement whose id already names a template is dropped, not merged over it', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', {
      enabled: true,
      templates: [{ name: 'Weekly', content: 'The one already here.' }],
      components: [],
    });

    await retire();

    const templates = templatesOf(await moduleRow('messages'));

    expect(templates).toHaveLength(1);
    expect(templates[0]?.content).toBe('The one already here.');
  });

  test('the announcements module row is gone', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });

    await retire();

    expect(await moduleRow('announcements')).toBeUndefined();
  });

  // A row left booked under a module that no longer exists fires into nothing: the announcement
  // silently stops, which is the whole hazard this migration exists to avoid.
  test('a booking that could not be moved is deleted rather than left to fire into nothing', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', { enabled: true, templates: [], components: [] });

    await seedBooking('weekly');
    await handle.client`
      insert into scheduled_actions (id, guild_id, run_at, kind, payload, idempotency_key)
      values ('sa-taken', ${GUILD}, now(), 'module_job',
        ${JSON.stringify({
          kind: 'module',
          moduleId: 'messages',
          jobId: 'post',
          guildId: GUILD,
          data: { templateName: 'weekly', runAt: '2026-10-01T09:00:00.000Z' },
        })}::jsonb,
        ${`messages:post:${GUILD}:weekly`})
    `;

    await retire();

    const rows = await bookings();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('sa-taken');
  });

  test('a booking belonging to another module is left alone', async () => {
    await handle.client`
      insert into scheduled_actions (id, guild_id, run_at, kind, payload, idempotency_key)
      values ('sa-other', ${GUILD}, now(), 'module_job',
        ${JSON.stringify({
          kind: 'module',
          moduleId: 'giveaways',
          jobId: 'draw',
          guildId: GUILD,
          data: {},
        })}::jsonb,
        ${`giveaways:draw:${GUILD}:g1`})
    `;

    await retire();

    expect((await bookings()).map((r) => r.idempotency_key)).toEqual([
      `giveaways:draw:${GUILD}:g1`,
    ]);
  });

  test('running it twice changes nothing the second time', async () => {
    await seedModule('announcements', { enabled: true, scheduled: [WEEKLY] });
    await seedModule('messages', { enabled: true, templates: [], components: [] });
    await seedBooking('weekly');

    await retire();
    const once = { module: await moduleRow('messages'), booked: await bookings() };
    await retire();

    expect(await moduleRow('messages')).toEqual(once.module as Record<string, unknown>);
    expect(await bookings()).toEqual(once.booked);
  });

  test('a guild with no announcements at all is untouched', async () => {
    await seedModule('messages', {
      enabled: true,
      templates: [{ name: 'rules', content: 'Be kind.' }],
      components: [],
    });

    await retire();

    expect(templatesOf(await moduleRow('messages'))).toHaveLength(1);
  });
});
