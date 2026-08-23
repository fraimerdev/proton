import { describe, expect, test } from 'bun:test';
import { messagesConfigSchema, savedMessageSchema } from '../src/config.ts';
import { reconcile } from '../src/schedule.ts';

/**
 * 0018 builds each migrated template as jsonb, and no database is reachable on this host to run it
 * against. The shape it writes is reproduced here so the likeliest failure — a template the module
 * then refuses to parse, which would take the whole Messages page down for that guild — is caught
 * without one. Keep this in step with the jsonb_build_object in the migration.
 */
function asMigrated(announcement: Record<string, unknown>): Record<string, unknown> {
  const schedule: Record<string, unknown> = {
    channelId: announcement.channelId,
    at: announcement.at,
    mode: announcement.mode ?? 'once',
    every: announcement.every,
    pingRoleId: announcement.pingRoleId,
    enabled: announcement.enabled ?? true,
  };

  // jsonb_strip_nulls, which is what drops `every` and `pingRoleId` when the announcement had none.
  for (const [key, value] of Object.entries(schedule)) {
    if (value === null || value === undefined) delete schedule[key];
  }

  return {
    name: announcement.id,
    content: announcement.message,
    embeds: [],
    components: [],
    v2: [],
    mentions: { everyone: false, roles: true, users: true },
    schedule,
  };
}

const REPEATING = {
  id: 'weekly',
  name: 'Weekly notice',
  channelId: '500000000000000001',
  message: 'Stand up at nine.',
  mode: 'repeat',
  at: '2026-09-01T09:00:00.000Z',
  every: '7d',
  pingRoleId: '600000000000000001',
  enabled: true,
};

const ONE_OFF = {
  id: 'launch',
  name: 'Launch day',
  channelId: '500000000000000001',
  message: 'We are live.',
  mode: 'once',
  at: '2026-10-01T12:00:00.000Z',
  enabled: true,
};

describe('what the retirement migration writes', () => {
  test('a repeating announcement parses as a scheduled template', () => {
    const parsed = savedMessageSchema.parse(asMigrated(REPEATING));

    expect(parsed.name).toBe('weekly');
    expect(parsed.content).toBe('Stand up at nine.');
    expect(parsed.schedule?.mode).toBe('repeat');
    expect(parsed.schedule?.every).toBe('7d');
    expect(parsed.schedule?.pingRoleId).toBe('600000000000000001');
  });

  test('a one-off with no interval and no ping role parses too', () => {
    const parsed = savedMessageSchema.parse(asMigrated(ONE_OFF));

    expect(parsed.schedule?.mode).toBe('once');
    expect(parsed.schedule?.every).toBeUndefined();
    expect(parsed.schedule?.pingRoleId).toBeUndefined();
  });

  test('a switched-off announcement stays switched off', () => {
    const parsed = savedMessageSchema.parse(asMigrated({ ...ONE_OFF, enabled: false }));

    expect(parsed.schedule?.enabled).toBe(false);
  });

  test('the whole config still parses with migrated templates in it', () => {
    const config = messagesConfigSchema.parse({
      enabled: true,
      templates: [asMigrated(REPEATING), asMigrated(ONE_OFF)],
      components: [],
    });

    expect(config.templates.map((t) => t.name)).toEqual(['weekly', 'launch']);
  });

  // The point of keeping the announcement id as the template name: reconcile has to book it under
  // the same natural key the rewritten scheduled_actions row already carries.
  test('reconcile books a migrated template under the key its row already has', () => {
    const config = messagesConfigSchema.parse({
      enabled: true,
      templates: [asMigrated(REPEATING)],
      components: [],
    });

    const plan = reconcile(config, new Date('2026-08-01T00:00:00.000Z'));

    expect(plan.schedule[0]?.key).toBe('weekly');
  });

  test('an announcement carrying an empty message would be refused rather than written blank', () => {
    const empty = savedMessageSchema.safeParse(asMigrated({ ...ONE_OFF, message: '' }));

    expect(empty.success).toBe(false);
  });
});
