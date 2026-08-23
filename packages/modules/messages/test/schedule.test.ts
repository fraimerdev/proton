import { describe, expect, test } from 'bun:test';
import type { DiscordMessageBody } from '@proton/core';
import {
  type MessagesConfig,
  messagesConfigSchema,
  type SavedMessage,
  templateScheduleSchema,
} from '../src/config.ts';
import { followingRun, nextRun, reconcile, scheduledTemplates } from '../src/schedule.ts';
import { postDataSchema, postKey, withPing } from '../src/scheduled-post.ts';

const CHANNEL = '500000000000000001';
const ROLE = '600000000000000001';
const AT = '2026-09-01T09:00:00.000Z';

function schedule(overrides: Record<string, unknown> = {}) {
  return templateScheduleSchema.parse({ channelId: CHANNEL, at: AT, ...overrides });
}

function template(name: string, overrides: Record<string, unknown> = {}): SavedMessage {
  return {
    name,
    content: 'Hello',
    embeds: [],
    components: [],
    mentions: { everyone: false, roles: true, users: true },
    v2: [],
    ...overrides,
  } as SavedMessage;
}

function config(templates: SavedMessage[], enabled = true): MessagesConfig {
  return messagesConfigSchema.parse({ enabled, templates });
}

describe('the schedule on a template', () => {
  test('is absent unless one is set, so a template posts only on request', () => {
    expect(config([template('rules')]).templates[0]?.schedule).toBeUndefined();
  });

  test('defaults to posting once, switched on', () => {
    const parsed = schedule();

    expect(parsed.mode).toBe('once');
    expect(parsed.enabled).toBe(true);
  });

  test('a repeat with no interval is refused, and says what an interval looks like', () => {
    const bad = templateScheduleSchema.safeParse({ channelId: CHANNEL, at: AT, mode: 'repeat' });

    expect(bad.success).toBe(false);
    expect(bad.success === false && bad.error.issues[0]?.message).toContain('such as 24h or 7d');
  });

  test('a repeat faster than the floor is refused', () => {
    const bad = templateScheduleSchema.safeParse({
      channelId: CHANNEL,
      at: AT,
      mode: 'repeat',
      every: '10s',
    });

    expect(bad.success).toBe(false);
  });

  test('a start time without a timezone is refused, because 09:00 names no moment', () => {
    const bad = templateScheduleSchema.safeParse({ channelId: CHANNEL, at: '2026-09-01T09:00:00' });

    expect(bad.success).toBe(false);
  });
});

describe('when a scheduled template next runs', () => {
  const before = new Date('2026-08-01T00:00:00.000Z');
  const after = new Date('2026-09-02T10:00:00.000Z');

  test('a one-off ahead of us is due at its moment', () => {
    const next = nextRun(schedule(), before);

    expect(next.status).toBe('due');
    expect(next.status === 'due' && next.runAt.toISOString()).toBe(AT);
  });

  test('a one-off behind us has passed', () => {
    expect(nextRun(schedule(), after).status).toBe('passed');
  });

  test('a repeat behind us lands on its next slot, not its first', () => {
    const next = nextRun(schedule({ mode: 'repeat', every: '24h' }), after);

    expect(next.status === 'due' && next.runAt.toISOString()).toBe('2026-09-03T09:00:00.000Z');
  });

  // nextRun is at-or-after by design: a worker starting up exactly on a slot should book that
  // slot, not skip it. followingRun is the strict one, and only the post path uses it.
  test('a repeat asked about exactly on a slot books that slot', () => {
    const onTheSlot = new Date('2026-09-02T09:00:00.000Z');
    const next = nextRun(schedule({ mode: 'repeat', every: '24h' }), onTheSlot);

    expect(next.status === 'due' && next.runAt.toISOString()).toBe('2026-09-02T09:00:00.000Z');
  });

  // nextRun is at-or-after, so a repeat that has just fired on its exact slot would book that same
  // moment again and post in a loop until the row was cancelled.
  test('the run after one that just fired is strictly later', () => {
    const justRan = new Date(AT);

    const following = followingRun(schedule({ mode: 'repeat', every: '24h' }), justRan);

    expect(following.status === 'due' && following.runAt.toISOString()).toBe(
      '2026-09-02T09:00:00.000Z',
    );
  });
});

describe('reconcile', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  test('books a template that carries a live schedule', () => {
    const plan = reconcile(config([template('rules', { schedule: schedule() })]), now);

    expect(plan.schedule.map((i) => i.name)).toEqual(['rules']);
    expect(plan.cancel).toEqual([]);
  });

  test('ignores a template with no schedule at all', () => {
    const plan = reconcile(config([template('rules')]), now);

    expect(plan.schedule).toEqual([]);
    expect(plan.cancel).toEqual([]);
  });

  test('cancels everything while the module is switched off', () => {
    const plan = reconcile(config([template('rules', { schedule: schedule() })], false), now);

    expect(plan.schedule).toEqual([]);
    expect(plan.cancel[0]?.reason).toBe('module-off');
  });

  test('cancels a schedule switched off on its own', () => {
    const off = schedule({ enabled: false });
    const plan = reconcile(config([template('rules', { schedule: off })]), now);

    expect(plan.cancel[0]?.reason).toBe('switched-off');
  });

  // A one-off whose moment is behind us may still be sitting due in the schedule after downtime,
  // and cancelling it here would delete it unfired.
  test('leaves a passed one-off in neither list', () => {
    const plan = reconcile(
      config([template('rules', { schedule: schedule() })]),
      new Date('2026-09-02T09:00:00.000Z'),
    );

    expect(plan.schedule).toEqual([]);
    expect(plan.cancel).toEqual([]);
  });

  // The booked row's natural key is the normalised name, so a rename has to move the booking.
  test('books under the normalised name, which is what /message post looks up', () => {
    const plan = reconcile(config([template('Server Rules', { schedule: schedule() })]), now);

    expect(plan.schedule[0]?.key).toBe('server rules');
  });

  test('scheduledTemplates names only the ones carrying a schedule', () => {
    const both = config([template('rules', { schedule: schedule() }), template('welcome')]);

    expect(scheduledTemplates(both).map((t) => t.name)).toEqual(['rules']);
  });
});

/**
 * A row booked by the retired announcements module is still sitting in scheduled_actions naming
 * its template with the old key, and no migration can reach one written after the migration ran.
 */
describe('the data a booked row carries', () => {
  test('reads a row this module booked', () => {
    const read = postDataSchema.safeParse({ templateName: 'rules', runAt: AT });

    expect(read.success && read.data.templateName).toBe('rules');
  });

  test('reads a row announcements booked, under its old key', () => {
    const read = postDataSchema.safeParse({ announcementId: 'rules', runAt: AT });

    expect(read.success && read.data.templateName).toBe('rules');
  });

  test('refuses a row naming no template at all', () => {
    expect(postDataSchema.safeParse({ runAt: AT }).success).toBe(false);
  });

  test('the idempotency root carries the run, so a repeat is not dropped as a duplicate', () => {
    expect(postKey('900000000000000001', 'Rules', AT)).not.toBe(
      postKey('900000000000000001', 'Rules', '2026-09-02T09:00:00.000Z'),
    );
  });

  test('and is normalised, so the same template cannot post twice under two spellings', () => {
    expect(postKey('900', 'Rules', AT)).toBe(postKey('900', 'rules', AT));
  });
});

/**
 * Discord refuses `parse` alongside the explicit users/roles arrays, so a ping role has to replace
 * the template's own mention policy rather than sit beside it.
 */
describe('withPing', () => {
  const body: DiscordMessageBody = {
    content: 'Stand up meeting',
    allowedMentions: { parse: ['roles', 'users'] },
  };

  test('leaves a message with no ping role exactly as it was', () => {
    expect(withPing(body, undefined)).toBe(body);
  });

  test('never sends parse and an explicit roles list together', () => {
    const pinged = withPing(body, ROLE);

    expect(pinged.allowedMentions).toEqual({ parse: [], roles: [ROLE] });
  });

  test('writes the mention above the message, the way it reads in Discord', () => {
    expect(withPing(body, ROLE).content).toBe(`<@&${ROLE}>\nStand up meeting`);
  });

  test('a message with no text of its own is just the mention', () => {
    expect(withPing({ allowedMentions: { parse: [] } } as DiscordMessageBody, ROLE).content).toBe(
      `<@&${ROLE}>`,
    );
  });

  // A components-v2 message carries no content field at all — Discord refuses the whole message
  // if one is present under the flag.
  test('adds no content to a layout, only the permission to ping', () => {
    const laidOut: DiscordMessageBody = {
      components: [],
      flags: 32_768,
      allowedMentions: { parse: [] },
    };

    expect(withPing(laidOut, ROLE)).not.toHaveProperty('content');
    expect(withPing(laidOut, ROLE).allowedMentions).toEqual({ parse: [], roles: [ROLE] });
  });
});
