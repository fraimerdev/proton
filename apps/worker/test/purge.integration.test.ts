import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { countGuildRows, createDb, type DbHandle, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  GUILD_KEY_FAMILIES,
  type GuildPurgeDeps,
  type PurgeRedisDb,
  runGuildPurge,
  runUserPurge,
} from '../src/purge.ts';
import { RULE_CRON_QUEUE } from '../src/rule-runtime.ts';

const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const USER = '400000000000000001';

const DB: Record<PurgeRedisDb | 'jobs', number> = { modules: 4, state: 5, messages: 7, jobs: 3 };
const DAY = '2026-09-18T12:00:00.000Z';
const NOW = '2026-09-18T15:00:00.000Z';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let redis: Record<PurgeRedisDb, Redis>;
let cron: Queue;

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
  await handle.client`
    create table if not exists message_logs_2026_09_18 partition of message_logs
      for values from ('2026-09-18T00:00:00Z') to ('2026-09-19T00:00:00Z')
  `;

  const url = redisContainer.getConnectionUrl();
  redis = {
    modules: new Redis(url, { db: DB.modules }),
    state: new Redis(url, { db: DB.state }),
    messages: new Redis(url, { db: DB.messages }),
  };
  cron = new Queue(RULE_CRON_QUEUE, {
    connection: { url, db: DB.jobs, maxRetriesPerRequest: null },
  });
}, 240_000);

afterAll(async () => {
  await cron?.close();
  for (const client of Object.values(redis ?? {})) client.disconnect();
  await handle?.close();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
}, 240_000);

async function seedGuild(g: string): Promise<void> {
  const sql = handle.client;
  const id = (name: string) => `${name}-${g}`;

  await sql`insert into guilds (id, name) values (${g}, ${`server ${g}`})`;
  await sql`insert into guild_modules (guild_id, module_id) values (${g}, 'automod')`;
  await sql`insert into audit_trail (id, guild_id, actor_id, source, action)
            values (${id('audit')}, ${g}, ${USER}, 'dashboard', 'config.update')`;
  await sql`insert into backups (id, guild_id) values (${id('backup')}, ${g})`;
  await sql`insert into cases (id, guild_id, case_number, type, module_id, idempotency_key)
            values (${id('case')}, ${g}, 1, 'ban', 'moderation', ${id('case-key')})`;
  await sql`insert into entitlements (guild_id, sku_id, tier, source)
            values (${g}, 'sku', 'pro', 'discord')`;
  await sql`insert into members (guild_id, user_id) values (${g}, ${USER})`;
  await sql`insert into rules (id, guild_id, module_id, trigger)
            values (${id('rule')}, ${g}, 'automod',
                    '{"kind":"event","event":"message.created"}'::jsonb)`;
  await sql`insert into scheduled_actions (id, guild_id, run_at, kind, idempotency_key)
            values (${id('scheduled')}, ${g}, ${DAY}, 'module_job', ${id('scheduled-key')})`;
  await sql`insert into message_logs (id, guild_id, channel_id, message_id, kind, occurred_at)
            values (${id('log')}, ${g}, '1', '2', 'deleted', ${DAY})`;
  await sql`insert into starboard_posts (guild_id, source_message_id, board_message_id, star_count)
            values (${g}, '1', '2', 3)`;
  await sql`insert into tags (guild_id, name, content, created_by)
            values (${g}, 'rules', 'be kind', ${USER})`;
  await sql`insert into reminders (id, guild_id, user_id, channel_id, content, remind_at)
            values (${id('reminder')}, ${g}, ${USER}, '1', 'stand up', ${DAY})`;
  await sql`insert into polls (guild_id, channel_id, message_id, created_by, question, ends_at)
            values (${g}, '1', '2', ${USER}, 'tea?', ${DAY})`;

  await sql`insert into giveaways (id, guild_id, channel_id, host_id, title, winner_count, ends_at,
                                   created_by)
            values (${id('giveaway')}, ${g}, '1', ${USER}, 'Nitro', 1, ${DAY}, ${USER})`;
  await sql`insert into giveaway_entries (giveaway_id, user_id) values (${id('giveaway')}, ${USER})`;
  await sql`insert into giveaway_requirements (id, giveaway_id, provider_id, config, position)
            values (${id('requirement')}, ${id('giveaway')}, 'core.role', '{}'::jsonb, 0)`;
  await sql`insert into giveaway_multipliers (id, giveaway_id, provider_id, config, mode, position)
            values (${id('multiplier')}, ${id('giveaway')}, 'core.role', '{}'::jsonb, 'add', 0)`;
  await sql`insert into giveaway_draws (id, giveaway_id, draw_number, seed, snapshot_hash,
                                        entrant_count, total_entries, drawn_by)
            values (${id('draw')}, ${id('giveaway')}, 1, 'seed', 'hash', 1, 1, ${USER})`;
  await sql`insert into giveaway_wins (giveaway_id, draw_id, user_id)
            values (${id('giveaway')}, ${id('draw')}, ${USER})`;
  await sql`insert into giveaway_bonus_entries (id, giveaway_id, user_id, amount, granted_by)
            values (${id('bonus')}, ${id('giveaway')}, ${USER}, 2, ${USER})`;
  await sql`insert into giveaway_events (id, guild_id, giveaway_id, kind, actor_id)
            values (${id('giveaway-event')}, ${g}, ${id('giveaway')}, 'created', ${USER})`;
  await sql`insert into giveaway_templates (id, guild_id, name, payload, created_by)
            values (${id('template')}, ${g}, 'weekly', '{}'::jsonb, ${USER})`;
  await sql`insert into giveaway_blacklist (guild_id, subject_type, subject_id, added_by)
            values (${g}, 'user', ${USER}, ${USER})`;

  await sql`insert into suggestions (id, guild_id, number, channel_id, author_id, content)
            values (${id('suggestion')}, ${g}, 1, '1', ${USER}, 'more tea')`;
  await sql`insert into suggestion_votes (suggestion_id, user_id, vote)
            values (${id('suggestion')}, ${USER}, 1)`;

  await sql`insert into tickets (id, guild_id, number, type_id, panel_id, channel_id, opener_id,
                                 owner_id)
            values (${id('ticket')}, ${g}, 1, 'support', 'main', '1', ${USER}, ${USER})`;
  await sql`insert into ticket_participants (ticket_id, user_id) values (${id('ticket')}, ${USER})`;
  await sql`insert into ticket_events (id, ticket_id, guild_id, type)
            values (${id('ticket-event')}, ${id('ticket')}, ${g}, 'opened')`;
  await sql`insert into ticket_form_answers (ticket_id, field_id, label, value)
            values (${id('ticket')}, 'why', 'Why?', 'help')`;
  await sql`insert into ticket_messages (id, ticket_id, message_id, author_id, author_name,
                                         expires_at)
            values (${id('ticket-message')}, ${id('ticket')}, '2', ${USER}, 'someone', ${NOW})`;
  await sql`insert into ticket_blacklist (id, guild_id, user_id, created_by)
            values (${id('ticket-block')}, ${g}, ${USER}, ${USER})`;
  await sql`insert into ticket_ratings (ticket_id, guild_id, user_id, rating)
            values (${id('ticket')}, ${g}, ${USER}, 5)`;

  await sql`insert into member_activity_daily (guild_id, user_id, day)
            values (${g}, ${USER}, '2026-09-18')`;
  await sql`insert into temp_voice_channels (id, guild_id, hub_channel_id)
            values (${id('temp-vc')}, ${g}, '1')`;
  await sql`insert into temp_voice_access (temp_channel_id, user_id, kind)
            values (${id('temp-vc')}, ${USER}, 'trusted')`;
  await sql`insert into temp_voice_roles (temp_channel_id, user_id, role_id)
            values (${id('temp-vc')}, ${USER}, '3')`;
  await sql`insert into counter_channels (guild_id, counter_id, channel_id)
            values (${g}, 'members', '1')`;
  await sql`insert into branding_assets (guild_id, kind, content_type, base64, hash, byte_size)
            values (${g}, 'avatar', 'image/png', 'AA==', 'hash', 1)`;
  await sql`insert into branding_roles (guild_id, role_id) values (${g}, '3')`;
  await sql`insert into branding_name_styles (guild_id, outcome) values (${g}, 'applied')`;
  await sql`insert into blocked_members (id, guild_id, user_id, module_id, blocked_by, reason,
                                         idempotency_key)
            values (${id('block')}, ${g}, ${USER}, 'honeypot', ${USER}, 'bait', ${id('block-key')})`;
  await sql`insert into appeals (id, guild_id, number, user_id, panel_id, origin, jti)
            values (${id('appeal')}, ${g}, 1, ${USER}, 'default', 'ban', 'jti')`;
  await sql`insert into appeal_answers (id, appeal_id, position, question_key, label, value)
            values (${id('answer')}, ${id('appeal')}, 0, 'why', 'Why?', 'sorry')`;
  await sql`insert into afk_statuses (guild_id, user_id, session_id, since)
            values (${g}, ${USER}, ${id('afk')}, ${DAY})`;
  await sql`insert into afk_pings (session_id, guild_id, user_id, message_id, channel_id,
                                   author_id, pinged_at)
            values (${id('afk')}, ${g}, ${USER}, '2', '1', ${USER}, ${DAY})`;
  await sql`insert into xp_events (guild_id, id, multiplier_tenths, starts_at, ends_at, created_by)
            values (${g}, 'double', 20, ${DAY}, ${NOW}, ${USER})`;
  await sql`insert into reports (id, guild_id, number, reporter_id, target_id, method,
                                 idempotency_key)
            values (${id('report')}, ${g}, 1, ${USER}, '5', 'member', ${id('report-key')})`;
  await sql`insert into report_events (id, report_id, guild_id, kind, actor_id, source)
            values (${id('report-event')}, ${id('report')}, ${g}, 'submitted', ${USER}, 'discord')`;
  await sql`insert into report_automation_runs (id, guild_id, rule_id, rule_name, target_id,
                                                episode_start, covered_until, lease_until)
            values (${id('report-run')}, ${g}, 'repeat', 'Repeat', '5', ${DAY}, ${DAY}, ${NOW})`;
  await sql`insert into moderation_timeouts (case_id, guild_id, user_id, started_at, ends_at)
            values (${id('case')}, ${g}, ${USER}, ${DAY}, ${NOW})`;
  await sql`insert into moderation_case_messages (case_id, message_id, guild_id, channel_id,
                                                  author_id, created_at, expires_at)
            values (${id('case')}, '2', ${g}, '1', ${USER}, ${DAY}, ${NOW})`;

  await sql`insert into xp_grants (guild_id, grant_id, user_id, amount, source_module, causation,
                                   previous_level, level, xp_after)
            values (${g}, ${id('grant')}, ${USER}, 250, 'achievements',
                    '{"kind":"achievement","rootId":"event-1","depth":1}'::jsonb, 1, 2, 400)`;
  await sql`insert into achievement_seen (guild_id, metric, source_key, user_id, occurred_at)
            values (${g}, 'messages', '2', ${USER}, ${DAY})`;
  await sql`insert into achievement_activity (guild_id, user_id, metric, hour, amount_sum,
                                              amount_max, events)
            values (${g}, ${USER}, 'messages', ${DAY}, 1, 1, 1)`;
  await sql`insert into achievement_progress (guild_id, achievement_id, requirement_id, user_id,
                                              value, version)
            values (${g}, 'chatterbox', 'messages', ${USER}, 1, 1)`;
  await sql`insert into achievement_members (guild_id, achievement_id, user_id)
            values (${g}, 'chatterbox', ${USER})`;
  await sql`insert into achievement_state (guild_id, achievement_id)
            values (${g}, 'chatterbox')`;
  await sql`insert into achievement_periods (guild_id, achievement_id, started_at)
            values (${g}, '', ${DAY})`;
  await sql`insert into achievement_unlocks (guild_id, user_id, achievement_id, tier_id, generation,
                                             tier_index, unlocked_at, revision, definition, cause,
                                             announce_group)
            values (${g}, ${USER}, 'chatterbox', 'bronze', 0, 0, ${DAY}, 'revision',
                    '{}'::jsonb, '{}'::jsonb, ${id('announce')})`;
  await sql`insert into achievement_rewards (guild_id, user_id, achievement_id, tier_id,
                                             generation, reward_key, reward_epoch, kind, amount)
            values (${g}, ${USER}, 'chatterbox', 'bronze', 0, 'xp', 0, 'xp', 250)`;
  await sql`insert into achievement_member_facts (guild_id, user_id, joined_at)
            values (${g}, ${USER}, ${DAY})`;
  await sql`insert into achievement_badges (guild_id, asset_id, content_type, base64, byte_size,
                                            uploaded_by)
            values (${g}, 'badge0001', 'image/png', 'AA==', 1, ${USER})`;

  await sql`insert into guild_commands (guild_id, command_key, name, updated_by)
            values (${g}, 'ban', 'punish', ${USER})`;
  await sql`insert into guild_command_registrations (guild_id, scope, definition_hash, commands,
                                                     id_history)
            values (${g}, 'every-guild', 'hash',
                    '[{"key":"ban","id":"1300000000000000001","name":"punish","kind":"chat"}]'::jsonb,
                    '{"1300000000000000001":"ban"}'::jsonb)`;

  await sql`insert into application_form_versions (id, guild_id, form_id, version, snapshot,
                                                   published_by)
            values (${id('form-version')}, ${g}, 'mods', 1, '{}'::jsonb, ${USER})`;
  await sql`insert into applications (id, guild_id, number, form_id, version_id, applicant_id,
                                      status)
            values (${id('application')}, ${g}, 1, 'mods', ${id('form-version')}, ${USER},
                    'submitted')`;
  await sql`insert into application_events (id, guild_id, application_id, kind, actor_id, source,
                                            revision)
            values (${id('application-event')}, ${g}, ${id('application')}, 'submitted', ${USER},
                    'discord', 1)`;
  await sql`insert into application_thread (id, guild_id, application_id, kind, author_id, body,
                                            revision)
            values (${id('application-thread')}, ${g}, ${id('application')}, 'info_request',
                    ${USER}, 'when?', 1)`;
  await sql`insert into application_notes (id, guild_id, application_id, author_id, body)
            values (${id('application-note')}, ${g}, ${id('application')}, ${USER}, 'ok')`;
  await sql`insert into application_votes (guild_id, application_id, reviewer_id, vote)
            values (${g}, ${id('application')}, ${USER}, 'accept')`;
  await sql`insert into application_effects (id, guild_id, application_id, key, kind, trigger,
                                             revision)
            values (${id('application-effect')}, ${g}, ${id('application')}, 'card', 'card', 'card',
                    1)`;
  await sql`insert into application_role_grants (guild_id, application_id, user_id, role_id)
            values (${g}, ${id('application')}, ${USER}, '3')`;
}

const concrete = (match: string, suffix: string) => match.replace('*', suffix);

async function seedRedis(g: string): Promise<void> {
  for (const family of GUILD_KEY_FAMILIES) {
    await redis[family.db].set(concrete(family.match(g), '123'), 'x');
  }
  await redis.modules.set(`proton:verification:captcha:${g}:${USER}`, 'x', 'PX', 600_000);

  await cron.upsertJobScheduler(
    `${g}:automod:weekly`,
    { pattern: '0 0 1 1 *' },
    { name: `${g}:automod:weekly`, data: { guildId: g, moduleId: 'automod', ruleId: 'weekly' } },
  );
}

async function redisHolds(g: string): Promise<number> {
  let found = 0;
  for (const family of GUILD_KEY_FAMILIES) {
    found += await redis[family.db].exists(concrete(family.match(g), '123'));
  }
  return found;
}

async function schedulersFor(g: string): Promise<string[]> {
  return (await cron.getJobSchedulers())
    .map((scheduler) => scheduler.key)
    .filter((key) => key.startsWith(`${g}:`));
}

function deps(): GuildPurgeDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    handle,
    redis,
    cron,
    operator: 'tester on test-host',
    now: () => new Date(NOW),
    print: (line) => lines.push(line),
    lines,
  };
}

beforeEach(async () => {
  await handle.client`delete from message_logs`;
  await handle.client`delete from giveaway_events`;
  await handle.client`delete from guilds`;
  await handle.client`delete from "user"`;
  for (const client of Object.values(redis)) await client.flushdb();
  for (const scheduler of await cron.getJobSchedulers()) {
    await cron.removeJobScheduler(scheduler.key);
  }

  await seedGuild(GUILD);
  await seedGuild(OTHER);
  await seedRedis(GUILD);
  await seedRedis(OTHER);
  await handle.client`update guilds set left_at = ${DAY} where id = ${GUILD}`;
});

describe('purging one server', () => {
  test('the seed reaches every table the purge knows about, so nothing below is vacuous', async () => {
    const before = await countGuildRows(handle, GUILD);

    expect(before.tables.filter((table) => table.rows === 0).map((table) => table.table)).toEqual(
      [],
    );
    expect(before.tables.map((table) => table.table)).toEqual(
      expect.arrayContaining([
        'message_logs',
        'giveaway_events',
        'giveaway_wins',
        'appeal_answers',
      ]),
    );
  });

  test('deletes every row, key and cron schedule for the server and nothing of another', async () => {
    const otherBefore = await countGuildRows(handle, OTHER);
    const out = deps();

    const code = await runGuildPurge(out, { id: GUILD, apply: true, force: false });

    expect(code).toBe(0);

    const after = await countGuildRows(handle, GUILD);
    expect(after.guild).toBeNull();
    expect(after.tables.filter((table) => table.rows > 0)).toEqual([]);

    const [logs] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from message_logs where guild_id = ${GUILD}`;
    const [events] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from giveaway_events where guild_id = ${GUILD}`;
    expect([logs?.n, events?.n]).toEqual([0, 0]);

    expect(await redisHolds(GUILD)).toBe(0);
    expect(await schedulersFor(GUILD)).toEqual([]);

    expect(await countGuildRows(handle, OTHER)).toEqual(otherBefore);
    expect(await redisHolds(OTHER)).toBe(GUILD_KEY_FAMILIES.length);
    expect(await schedulersFor(OTHER)).toEqual([`${OTHER}:automod:weekly`]);
  });

  test('keys that expire on their own are left to expire', async () => {
    await runGuildPurge(deps(), { id: GUILD, apply: true, force: false });

    expect(await redis.modules.exists(`proton:verification:captcha:${GUILD}:${USER}`)).toBe(1);
  });

  test('the report says what was deleted, when and by whom', async () => {
    const out = deps();
    await runGuildPurge(out, { id: GUILD, apply: true, force: false });

    const report = out.lines.join('\n');
    expect(report).toContain('DELETING');
    expect(report).toContain('tester on test-host');
    expect(report).toContain(NOW);
    expect(report).toMatch(new RegExp(`record:\\s+"server ${GUILD}", joined \\S+Z, left ${DAY}`));
    expect(report).toMatch(/message_logs\s+1 {2}direct/);
    expect(report).toMatch(/giveaway_entries\s+1 {2}cascade/);
    expect(report).toContain(`${RULE_CRON_QUEUE}: 1`);
    expect(report).toMatch(/verification quarantine records\s+1/);
  });

  test('a dry run counts everything and deletes nothing', async () => {
    const before = await countGuildRows(handle, GUILD);
    const out = deps();

    expect(await runGuildPurge(out, { id: GUILD, apply: false, force: false })).toBe(0);

    expect(await countGuildRows(handle, GUILD)).toEqual(before);
    expect(await redisHolds(GUILD)).toBe(GUILD_KEY_FAMILIES.length);
    expect(await schedulersFor(GUILD)).toHaveLength(1);
    expect(out.lines.join('\n')).toContain(`left ${DAY}`);
    expect(out.lines.join('\n')).toContain(`--delete --confirm ${GUILD}`);
  });

  test('the guilds row is read with real dates through the driver createDb installs', async () => {
    const { guild } = await countGuildRows(handle, GUILD);

    expect(guild?.leftAt?.toISOString()).toBe(DAY);
    expect(guild?.joinedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(guild?.joinedAt.getTime())).toBe(false);
    expect((await countGuildRows(handle, OTHER)).guild?.leftAt).toBeNull();
  });

  test('a dry run reads scheduler ids only, so a broken schedule of another server survives', async () => {
    const jobs = await cron.getBackend().client;
    await jobs.del(cron.toKey(`repeat:${OTHER}:automod:weekly`));
    const out = deps();

    expect(await runGuildPurge(out, { id: GUILD, apply: false, force: false })).toBe(0);

    expect(await jobs.zscore(cron.toKey('repeat'), `${OTHER}:automod:weekly`)).not.toBeNull();
    expect(out.lines.join('\n')).toContain(`${RULE_CRON_QUEUE}: 1 (${GUILD}:automod:weekly)`);
  });

  test('a GUILD_CREATE landing mid-purge keeps its row and rolls the whole purge back', async () => {
    await handle.client`delete from guilds where id = ${GUILD}`;
    await handle.client.unsafe(`
      create function purge_test_rejoin() returns trigger language plpgsql as $$
      begin
        insert into guilds (id, name) values ('${GUILD}', 'rejoined') on conflict do nothing;
        return null;
      end $$`);
    await handle.client`
      create trigger purge_test_rejoin after delete on giveaway_events
        for each statement execute function purge_test_rejoin()`;

    try {
      const out = deps();

      expect(await runGuildPurge(out, { id: GUILD, apply: true, force: false })).toBe(2);

      expect(out.lines.at(-1)).toMatch(/^REFUSED: Proton was added back to/);
      const [left] = await handle.client<{ guilds: number; events: number; logs: number }[]>`
        select (select count(*)::int from guilds where id = ${GUILD}) as guilds,
               (select count(*)::int from giveaway_events where guild_id = ${GUILD}) as events,
               (select count(*)::int from message_logs where guild_id = ${GUILD}) as logs`;
      expect(left).toEqual({ guilds: 0, events: 1, logs: 1 });
      expect(await redisHolds(GUILD)).toBe(GUILD_KEY_FAMILIES.length);
      expect(await schedulersFor(GUILD)).toHaveLength(1);
    } finally {
      await handle.client`drop trigger if exists purge_test_rejoin on giveaway_events`;
      await handle.client`drop function if exists purge_test_rejoin()`;
    }
  });

  test('a foreign key that would block the delete is refused under the header', async () => {
    await handle.client`
      create table purge_test_notes (id text primary key, case_id text references cases (id))`;

    try {
      const out = deps();

      expect(await runGuildPurge(out, { id: GUILD, apply: true, force: false })).toBe(2);

      expect(out.lines.slice(0, 4).join('\n')).toMatch(
        /DELETING\n\s+subject:\s+server \d+\n\s+started:\s+\S+\n\s+operator:\s+tester on test-host/,
      );
      expect(out.lines.at(-1)).toMatch(/^REFUSED: purge_test_notes references cases/);
      const [logs] = await handle.client<{ n: number }[]>`
        select count(*)::int as n from message_logs where guild_id = ${GUILD}`;
      expect(logs?.n).toBe(1);
      expect(await redisHolds(GUILD)).toBe(GUILD_KEY_FAMILIES.length);
    } finally {
      await handle.client`drop table if exists purge_test_notes`;
    }
  });

  test('refuses a server Proton is still in, and deletes nothing anywhere', async () => {
    const before = await countGuildRows(handle, OTHER);
    const out = deps();

    expect(await runGuildPurge(out, { id: OTHER, apply: true, force: false })).toBe(2);

    expect(out.lines.join('\n')).toContain('REFUSED');
    expect(await countGuildRows(handle, OTHER)).toEqual(before);
    expect(await redisHolds(OTHER)).toBe(GUILD_KEY_FAMILIES.length);
    expect(await schedulersFor(OTHER)).toHaveLength(1);
  });

  test('--force purges a server Proton is still recorded in', async () => {
    expect(await runGuildPurge(deps(), { id: OTHER, apply: true, force: true })).toBe(0);

    expect((await countGuildRows(handle, OTHER)).guild).toBeNull();
    expect(await redisHolds(OTHER)).toBe(0);
  });

  test('a server with no guilds row still has its rows and keys found and removed', async () => {
    await handle.client`delete from guilds where id = ${GUILD}`;

    expect(await runGuildPurge(deps(), { id: GUILD, apply: true, force: false })).toBe(0);

    const [logs] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from message_logs where guild_id = ${GUILD}`;
    expect(logs?.n).toBe(0);
    expect(await redisHolds(GUILD)).toBe(0);
  });
});

async function seedSignIn(discordId: string, sessions: number): Promise<void> {
  const sql = handle.client;
  const userId = `user-${discordId}`;

  await sql`insert into "user" (id, name, email)
            values (${userId}, 'someone', ${`${discordId}@users.discord.invalid`})`;
  await sql`insert into account (id, "userId", "accountId", "providerId")
            values (${`account-${discordId}`}, ${userId}, ${discordId}, 'discord')`;
  for (let n = 0; n < sessions; n += 1) {
    await sql`insert into session (id, "userId", token, "expiresAt")
              values (${`session-${discordId}-${n}`}, ${userId}, ${`token-${discordId}-${n}`},
                      ${NOW})`;
  }
}

async function signInCounts(): Promise<Record<string, number>> {
  const [row] = await handle.client<{ users: number; accounts: number; sessions: number }[]>`
    select (select count(*)::int from "user") as users,
           (select count(*)::int from account) as accounts,
           (select count(*)::int from session) as sessions`;
  return { ...row };
}

describe('purging one person’s sign-in data', () => {
  const SOMEONE = '400000000000000011';
  const ELSE = '400000000000000012';

  test('deletes their user, account and sessions and nobody else’s', async () => {
    await seedSignIn(SOMEONE, 2);
    await seedSignIn(ELSE, 1);
    const out = deps();

    expect(await runUserPurge(out, { id: SOMEONE, apply: true, force: false })).toBe(0);

    expect(await signInCounts()).toEqual({ users: 1, accounts: 1, sessions: 1 });

    const [left] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from account where "accountId" = ${SOMEONE}`;
    expect(left?.n).toBe(0);

    const report = out.lines.join('\n');
    expect(report).toMatch(/session rows\s+2/);
    expect(report).toContain('tester on test-host');
    expect(report).toContain(`user user-${SOMEONE}, Discord account ${SOMEONE}`);
    expect(report).not.toContain('someone');
  });

  test('a dry run deletes nothing', async () => {
    await seedSignIn(SOMEONE, 2);

    expect(await runUserPurge(deps(), { id: SOMEONE, apply: false, force: false })).toBe(0);
    expect(await signInCounts()).toEqual({ users: 1, accounts: 1, sessions: 2 });
  });

  test('another provider’s account with the same id is not taken for a Discord one', async () => {
    await seedSignIn(ELSE, 1);
    await handle.client`update account set "providerId" = 'github' where "accountId" = ${ELSE}`;
    const out = deps();

    expect(await runUserPurge(out, { id: ELSE, apply: true, force: false })).toBe(0);

    expect(out.lines.join('\n')).toContain('No sign-in data is stored');
    expect(await signInCounts()).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test('server data about the same person is not touched', async () => {
    await seedSignIn(USER, 1);

    await runUserPurge(deps(), { id: USER, apply: true, force: false });

    const [members] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from members where user_id = ${USER}`;
    expect(members?.n).toBe(2);
  });
});
