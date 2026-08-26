import { describe, expect, test } from 'bun:test';
import { limitFor, newId, Permissions } from '@proton/core';
import { DELIVER_JOB } from '../src/deliver.ts';
import type { Reminder } from '../src/store.ts';
import {
  autocompleteEvent,
  CHANNEL,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  OTHER,
  stringOption,
  subcommand,
} from './harness.ts';

function remind(text = 'take the bread out', duration = '2h') {
  return [stringOption('duration', duration), stringOption('text', text)];
}

async function set(h: Harness, text = 'take the bread out', duration = '2h'): Promise<Reminder> {
  await h.run('remind', remind(text, duration));

  const reminder = [...h.reminders.rows.values()].at(-1);
  if (!reminder) throw new Error('the reminder was not stored');

  return reminder;
}

async function seed(h: Harness, userId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await h.reminders.create({
      id: newId(),
      guildId: GUILD,
      userId,
      channelId: CHANNEL,
      content: `reminder ${index}`,
      remindAt: new Date(Date.now() + 60_000 * (index + 1)),
    });
  }
}

describe('/remind', () => {
  test('stores the reminder and books exactly one delivery for it', async () => {
    const h = harness();
    const before = Date.now();

    const reminder = await set(h);

    expect(reminder).toMatchObject({
      userId: MEMBER,
      channelId: CHANNEL,
      content: 'take the bread out',
      deliveredAt: null,
    });

    expect(h.scheduler.booked).toHaveLength(1);
    expect(h.scheduler.booked[0]).toMatchObject({
      jobId: DELIVER_JOB,
      naturalKey: reminder.id,
      data: { reminderId: reminder.id },
    });

    const runAt = h.scheduler.booked[0]?.runAt.getTime() ?? 0;
    expect(runAt).toBeGreaterThanOrEqual(before + 7_200_000);
    expect(runAt).toBeLessThanOrEqual(Date.now() + 7_200_000);
  });

  test('confirms with a timestamp Discord renders in the member’s own clock', async () => {
    const h = harness();

    const reminder = await set(h);

    expect(h.replyContent()).toContain(`<t:${Math.floor(reminder.remindAt.getTime() / 1000)}:R>`);
  });

  test('refuses an unreadable duration before storage is touched', async () => {
    const h = harness();

    await h.run('remind', remind('anything', 'tomorrow-ish'));

    expect(h.reminders.rows.size).toBe(0);
    expect(h.scheduler.booked).toHaveLength(0);
    expect(h.replyContent()).toContain('not a valid duration');
  });

  test('refuses a reminder sooner than the floor and says which bound that was', async () => {
    const h = harness();

    await h.run('remind', remind('now now now', '5s'));

    expect(h.reminders.rows.size).toBe(0);
    expect(h.replyContent()).toContain('soonest');
    expect(h.replyContent()).toContain('30s');
  });

  test('refuses a reminder past the ceiling and says which bound that was', async () => {
    const h = harness();

    await h.run('remind', remind('one day', '400d'));

    expect(h.reminders.rows.size).toBe(0);
    expect(h.replyContent()).toContain('furthest');
    expect(h.replyContent()).toContain('365d');
  });

  test('refuses at the member’s limit, naming the tier, the number and the way out', async () => {
    const h = harness();
    const cap = limitFor('free', 'remindersPerUser');
    await seed(h, MEMBER, cap);

    await h.run('remind', remind('one too many'));

    expect(h.reminders.rows.size).toBe(cap);
    expect(h.scheduler.booked).toHaveLength(0);

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('free');
    expect(reply).toContain(String(cap));
    expect(reply).toContain('plus');
    expect(reply).toContain('/reminders cancel');
  });

  test('the limit is counted per member, not per server', async () => {
    const h = harness();
    await seed(h, OTHER, limitFor('free', 'remindersPerUser'));

    await h.run('remind', remind('mine'));

    expect(h.scheduler.booked).toHaveLength(1);
  });

  test('a delivered reminder no longer counts against the limit', async () => {
    const h = harness();
    const cap = limitFor('free', 'remindersPerUser');
    await seed(h, MEMBER, cap);

    const oldest = [...h.reminders.rows.values()][0];
    await h.reminders.markDelivered(GUILD, oldest?.id ?? '', new Date());

    await h.run('remind', remind('room for one more'));

    expect(h.scheduler.booked).toHaveLength(1);
  });

  test('a plus guild gets the plus allowance', async () => {
    const h = harness();
    await seed(h, MEMBER, limitFor('free', 'remindersPerUser'));

    await h.run('remind', remind('one more'), { tier: 'plus' });

    expect(h.scheduler.booked).toHaveLength(1);
  });

  test('tells the member when the deployment has no scheduler, instead of throwing', async () => {
    const h = harness();

    await h.run('remind', remind(), { scheduler: false });

    expect(h.reminders.rows.size).toBe(0);
    expect(h.replyContent()).toContain('no scheduler');
    expect(h.logs.some((line) => line.level === 'error')).toBe(true);
  });

  test('throws away the row when the delivery could not be booked', async () => {
    const h = harness();
    h.scheduler.throws = 'the scheduled_actions table is unreachable';

    await h.run('remind', remind());

    expect(h.reminders.rows.size).toBe(0);
    expect(h.replyContent()).toContain("couldn't book");
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('unreachable')),
    ).toBe(true);
  });

  test('says the module is switched off rather than saving a reminder nobody will see', async () => {
    const h = harness();

    await h.run('remind', remind(), { config: { enabled: false } });

    expect(h.reminders.rows.size).toBe(0);
    expect(h.replyContent()).toContain('switched off');
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();

    await h.run('remind', remind(), { deps: {} });

    expect(h.replyContent()).toContain("isn't fully wired up");
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('store'))).toBe(
      true,
    );
  });
});

describe('delivery', () => {
  test('posts once, in the channel it was set in, pinging only its owner', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.deliver({ reminderId: reminder.id });

    const posts = h.calls().filter((call) => call.path === `/channels/${CHANNEL}/messages`);
    expect(posts).toHaveLength(1);

    const body = posts[0]?.body as { content?: string; allowed_mentions?: unknown };
    expect(body.content).toContain(`<@${MEMBER}>`);
    expect(body.content).toContain('take the bread out');
    expect(body.allowed_mentions).toEqual({ parse: [], users: [MEMBER] });

    expect((await h.reminders.get(GUILD, reminder.id))?.deliveredAt).not.toBeNull();
  });

  test('a reminder that says @everyone goes out with the mention suppressed', async () => {
    const h = harness();
    const reminder = await set(h, '@everyone the raid starts');

    await h.deliver({ reminderId: reminder.id });

    const body = h.sent()[0];
    expect(body?.content).toContain('@everyone');
    expect(body?.allowed_mentions).toEqual({ parse: [], users: [MEMBER] });
  });

  test('a replayed schedule does not deliver twice', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.deliver({ reminderId: reminder.id });
    await h.deliver({ reminderId: reminder.id });

    expect(h.sent()).toHaveLength(1);
  });

  test('a cancelled reminder that still has a schedule posts nothing', async () => {
    const h = harness();
    const reminder = await set(h);
    await h.reminders.remove(GUILD, reminder.id, MEMBER);

    await h.deliver({ reminderId: reminder.id });

    expect(h.sent()).toHaveLength(0);
  });

  test('names the missing permission and leaves the reminder pending for the retry', async () => {
    const h = harness({ botPermissions: Permissions.ViewChannel });
    const reminder = await set(h);

    await expect(h.deliver({ reminderId: reminder.id })).rejects.toThrow(/Send Messages/);

    expect((await h.reminders.get(GUILD, reminder.id))?.deliveredAt).toBeNull();
  });

  test('a schedule whose data this build cannot read is dropped loudly, not retried', async () => {
    const h = harness();

    await h.deliver({ reminder: 'from-an-older-build' });

    expect(h.sent()).toHaveLength(0);
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('reminderId')),
    ).toBe(true);
  });

  test('an unbound store fails loudly, so the sweep retries rather than losing the reminder', async () => {
    const h = harness();

    await expect(h.deliver({ reminderId: 'anything' }, { deps: {} })).rejects.toThrow(/store/);
  });

  test('posting a reminder is not a moderation case', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.deliver({ reminderId: reminder.id });

    expect(h.recorder.recorded).toHaveLength(0);
  });
});

describe('/reminders list', () => {
  test('lists what the member has waiting, soonest first', async () => {
    const h = harness();
    await set(h, 'later', '6h');
    await set(h, 'sooner', '1h');

    await h.run('reminders', subcommand('list', []));

    const reply = h.bodies().at(-1)?.data?.content ?? '';
    expect(reply.indexOf('sooner')).toBeLessThan(reply.indexOf('later'));
    expect(reply).toContain('2 waiting');
  });

  test('does not show another member’s reminders', async () => {
    const h = harness();
    await seed(h, OTHER, 2);

    await h.run('reminders', subcommand('list', []));

    expect(h.replyContent()).toContain('no reminders waiting');
  });
});

describe('/reminders cancel', () => {
  test('deletes the reminder and retires its delivery', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', reminder.id)]));

    expect(await h.reminders.get(GUILD, reminder.id)).toBeNull();
    expect(h.scheduler.cancelled).toEqual([{ jobId: DELIVER_JOB, naturalKey: reminder.id }]);
    expect(h.bodies().at(-1)?.data?.content).toContain('Cancelled');
  });

  test('refuses to cancel a reminder somebody else set, and says whose it is', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', reminder.id)]), {
      userId: OTHER,
    });

    expect(await h.reminders.get(GUILD, reminder.id)).not.toBeNull();
    expect(h.scheduler.cancelled).toHaveLength(0);

    const reply = h.bodies().at(-1)?.data?.content ?? '';
    expect(reply).toContain(`<@${MEMBER}>`);
    expect(reply).toContain('only they can cancel it');
    expect(h.bodies().at(-1)?.data?.allowed_mentions).toEqual({ parse: [] });
  });

  test('says so when the reminder is already gone', async () => {
    const h = harness();

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', 'nothing-like-it')]));

    expect(h.replyContent()).toContain('/reminders list');
  });

  test('says so when the reminder has already been posted', async () => {
    const h = harness();
    const reminder = await set(h);
    await h.reminders.markDelivered(GUILD, reminder.id, new Date());

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', reminder.id)]));

    expect(h.bodies().at(-1)?.data?.content).toContain('already been posted');
  });

  test('still cancels, and warns, when the deployment has no scheduler', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', reminder.id)]), {
      scheduler: false,
    });

    expect(await h.reminders.get(GUILD, reminder.id)).toBeNull();
    expect(h.logs.some((line) => line.level === 'warn')).toBe(true);
  });
});

describe('autocomplete', () => {
  test('suggests the caller’s own pending reminders, id as the value', async () => {
    const h = harness();
    const reminder = await set(h);

    await h.autocomplete(autocompleteEvent('reminders', ''));

    expect(h.choices()).toHaveLength(1);
    expect(h.choices()[0]?.value).toBe(reminder.id);
    expect(String(h.choices()[0]?.name)).toContain('take the bread out');
  });

  test('narrows to what the member has typed', async () => {
    const h = harness();
    await set(h, 'water the plants');
    await set(h, 'call the vet');

    await h.autocomplete(autocompleteEvent('reminders', 'vet'));

    expect(h.choices()).toHaveLength(1);
    expect(String(h.choices()[0]?.name)).toContain('call the vet');
  });

  test('never offers somebody else’s reminders', async () => {
    const h = harness();
    await set(h);

    await h.autocomplete(autocompleteEvent('reminders', '', 'reminder', OTHER));

    expect(h.choices()).toEqual([]);
  });

  test('answers with an empty list rather than leaving the member on a spinner', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('reminders', 'nothing-matches'));

    expect(h.calls()).toHaveLength(1);
    expect(h.choices()).toEqual([]);
  });

  test('ignores an autocomplete for a command another module owns', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('tag', 'r'));

    expect(h.calls()).toHaveLength(0);
  });

  test('ignores a focused option that is not a reminder', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('reminders', 'r', 'duration'));

    expect(h.calls()).toHaveLength(0);
  });

  test('stays quiet while the module is switched off', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('reminders', ''), { config: { enabled: false } });

    expect(h.calls()).toHaveLength(0);
  });
});

describe('a redelivered /remind', () => {
  test('books one reminder, not two that both fire', async () => {
    const h = harness();
    const key = newId();

    await h.run('remind', remind('take the bread out', '2h'), { idempotencyKey: key });
    await h.run('remind', remind('take the bread out', '2h'), { idempotencyKey: key });

    expect(h.reminders.rows.size).toBe(1);
    expect(h.scheduler.booked).toHaveLength(1);
  });

  test('two genuinely different reminders both stand', async () => {
    const h = harness();

    await h.run('remind', remind('one', '2h'), { idempotencyKey: newId() });
    await h.run('remind', remind('two', '3h'), { idempotencyKey: newId() });

    expect(h.reminders.rows.size).toBe(2);
    expect(h.scheduler.booked).toHaveLength(2);
  });
});
