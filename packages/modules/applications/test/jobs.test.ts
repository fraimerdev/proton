import { describe, expect, test } from 'bun:test';
import { PATROL_IDLE_MS, REQUEST_ANSWER_TIMEOUT_MS } from '../src/constants.ts';
import {
  createScheduledHandlers,
  PURGE_BATCH,
  PURGE_ROUNDS,
  purgeApplications,
  runSweep,
  SWEEP_RETRY_MS,
} from '../src/jobs.ts';
import { wakeSlot } from '../src/store.ts';
import { DAY_MS } from '../src/web.ts';
import {
  APP_ID,
  configWith,
  EffectsHarness,
  failure,
  formConfig,
  GUILD,
  OWNER,
  REVIEW_CHANNEL,
  SUBMIT_ROLE,
  texts,
} from './effects-harness.ts';

const HOUR = 60 * 60 * 1000;

function harness(form: Parameters<typeof configWith>[1] = {}, settings = {}) {
  return new EffectsHarness(configWith(settings, form));
}

async function sweep(h: EffectsHarness): Promise<void> {
  const handlers = createScheduledHandlers(h.raw());
  await handlers.sweep({}, h.ctx);
}

describe('the sweep', () => {
  test('runs the effects that are due and books the next patrol for when more come due', async () => {
    const h = harness({ actions: { onAccept: { xp: 50 } } });
    await h.submit();
    await sweep(h);
    await h.accept();

    await sweep(h);

    expect(h.effects().every((effect) => ['succeeded', 'requested'].includes(effect.status))).toBe(
      true,
    );
    const requested = h.effect('accepted:xp');
    const due = requested.leaseUntil ?? 0;
    expect(due - h.clock).toBe(REQUEST_ANSWER_TIMEOUT_MS);

    const slot = wakeSlot(due);
    expect(h.scheduled.at(-1)).toEqual({ jobId: 'sweep', runAt: slot, naturalKey: `wake:${slot}` });
    expect(slot).toBeGreaterThan(h.clock);
  });

  test('books nothing when nothing is left to do', async () => {
    const h = harness();
    await h.submit();
    await h.move({
      action: 'claim',
      lifecycle: null,
      patch: { reviewDueAt: null },
    });
    await h.store.transition({
      guildId: GUILD,
      applicationId: APP_ID,
      action: 'reminded',
      actor: { id: 'proton:applications', source: 'system' },
      expect: {},
      patch: { remindedAt: h.clock },
      event: { kind: 'reminded' },
      bumpRevision: false,
    });

    await sweep(h);

    expect(h.scheduled).toEqual([]);
  });

  test('never sleeps longer than the idle cap while something is waiting', async () => {
    const h = harness();
    await h.submit();
    await sweep(h);

    const application = await h.application();
    expect(application.reviewDueAt).toBe(h.clock + 2 * DAY_MS);
    expect(h.scheduled.at(-1)?.runAt).toBe(wakeSlot(h.clock + PATROL_IDLE_MS));
  });

  test('reminds reviewers once when a review is overdue, without pinging anyone', async () => {
    const h = harness();
    await h.submit();
    await sweep(h);

    h.advance(2 * DAY_MS);
    await sweep(h);

    const reminder = h.byKind('reminder');
    expect(reminder).toHaveLength(1);
    expect(reminder[0]?.status).toBe('succeeded');

    const sent = h.callsOf('send').at(-1);
    expect(sent?.payload.channelId).toBe(REVIEW_CHANNEL);
    expect(String(sent?.payload.content)).toStartWith(
      'Moderator Application #1 has waited 2 days for review.',
    );
    expect(sent?.payload.allowedMentions).toEqual({ parse: [] });
    expect((await h.application()).remindedAt).toBe(h.clock);
    expect(h.store.eventsOf(APP_ID).map((event) => event.kind)).toContain('reminded');

    h.advance(DAY_MS);
    await sweep(h);
    expect(h.byKind('reminder')).toHaveLength(1);
  });

  test('with no review channel an overdue review is recorded as overdue, not as a reminder', async () => {
    const h = harness({}, { reviewChannelId: undefined });
    await h.submit();
    await sweep(h);

    h.advance(2 * DAY_MS);
    await sweep(h);

    expect(h.byKind('reminder')).toEqual([]);
    const kinds = h.store.eventsOf(APP_ID).map((event) => event.kind);
    expect(kinds).toContain('review_overdue');
    expect(kinds).not.toContain('reminded');
    expect((await h.application()).remindedAt).toBe(h.clock);
  });

  test('a reminder for an application decided in the meantime is skipped', async () => {
    const h = harness();
    await h.submit();
    h.advance(2 * DAY_MS);
    const work = await h.store.dueWork(GUILD, h.clock, 50);
    expect(work.reminders).toHaveLength(1);

    await h.accept();
    await sweep(h);

    expect(h.byKind('reminder')).toEqual([]);
  });

  test('turning reminders off stops an overdue one without posting it', async () => {
    const h = harness({}, { reviewReminderHours: 0 });
    await h.submit();
    h.advance(3 * DAY_MS);
    await sweep(h);

    expect(h.byKind('reminder')).toEqual([]);
    expect((await h.application()).remindedAt).not.toBeNull();
    expect(h.store.eventsOf(APP_ID).map((event) => event.kind)).not.toContain('reminded');
  });

  test('an unanswered question past its deadline expires the application and cleans up', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    await h.submit();
    await sweep(h);
    await h.requestInfo();

    h.advance(15 * DAY_MS);
    await sweep(h);

    const application = await h.application();
    expect(application.status).toBe('expired');
    expect(application.contentPurgeAt).toBe(h.clock + 30 * DAY_MS);
    expect(h.publishedOf('applications.expired')).toHaveLength(1);
    expect(h.roles(application.applicantId)).toEqual([]);

    const expired = h
      .callsOf('send')
      .filter((call) => call.payload.directMessage === true)
      .at(-1);
    expect(String(expired?.payload.content)).toContain('has expired');
  });

  test('does nothing while the module is off', async () => {
    const h = harness();
    await h.submit();
    h.config = { ...h.config, enabled: false };
    await sweep(h);

    expect(h.calls).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });

  test('a problem books a retry a minute out instead of losing the patrol', async () => {
    const h = harness();
    await h.submit();
    h.store.dueWork = async () => {
      throw new Error('database unavailable');
    };

    await runSweep(h.raw(), h.ctx);

    expect(h.scheduled.at(-1)?.runAt).toBe(wakeSlot(h.clock + SWEEP_RETRY_MS));
    expect(h.logs.some((log) => log.level === 'error')).toBe(true);
  });

  test('says what is missing when the store is not wired', async () => {
    const h = harness();
    await runSweep({}, h.ctx);

    expect(h.logs.map((log) => log.message).join('\n')).toContain('store');
    expect(h.scheduled).toEqual([]);
  });

  test('a full batch comes straight back for the rest', async () => {
    const h = harness();
    await h.submit();
    const real = h.store.dueWork.bind(h.store);
    h.store.dueWork = async (guildId, now, limit) => {
      const work = await real(guildId, now, limit);
      return limit === 0 ? work : { ...work, reminders: Array(limit).fill(await h.application()) };
    };

    await runSweep(h.raw(), h.ctx);

    expect(h.scheduled.at(-1)?.runAt).toBe(wakeSlot(h.clock));
  });
});

describe('the sweep while the module is off', () => {
  const OTHER_APP = '01JAPPLICATION00000000000B';

  function off(h: EffectsHarness): void {
    h.config = { ...h.config, enabled: false };
  }

  async function remove(h: EffectsHarness, applicationId = APP_ID): Promise<void> {
    await h.store.deleteApplication({
      guildId: GUILD,
      applicationId,
      actor: { id: OWNER, source: 'dashboard' },
      audit: {
        actorId: OWNER,
        source: 'dashboard',
        action: 'module.applications.delete',
        id: `audit-${applicationId}`,
      },
    });
  }

  test('still takes down a deleted application’s card, then rests', async () => {
    const h = harness();
    await h.submit();
    await sweep(h);
    const { cardMessageId } = await h.application();
    const booked = h.scheduled.length;

    off(h);
    await remove(h);
    await sweep(h);

    expect(h.callsOf('delete_message').map((call) => call.payload.messageId)).toEqual([
      cardMessageId,
    ]);
    expect(h.effect('delete_card').status).toBe('succeeded');
    expect(h.scheduled).toHaveLength(booked);
  });

  test('leaves paused work alone and never books a patrol for it', async () => {
    const h = new EffectsHarness(
      configWith({
        forms: [formConfig(), formConfig({ id: 'events', name: 'Event Staff' })],
      }),
    );
    await h.submit();
    await sweep(h);
    await h.submit({ id: OTHER_APP, formId: 'events' });
    const booked = h.scheduled.length;
    const calls = h.calls.length;

    off(h);
    await remove(h);
    await sweep(h);
    await sweep(h);

    expect(h.calls.slice(calls).map((call) => call.kind)).toEqual(['delete_message']);
    expect(h.effects(OTHER_APP).every((effect) => effect.status === 'pending')).toBe(true);
    expect(h.scheduled).toHaveLength(booked);
  });

  test('tries a failed card removal again when its backoff ends', async () => {
    const h = harness();
    await h.submit();
    await sweep(h);
    const booked = h.scheduled.length;

    off(h);
    h.respond = (request) =>
      request.kind === 'delete_message' ? failure('discord_503', 'Discord is busy.') : undefined;
    await remove(h);
    await sweep(h);

    const pending = h.effect('delete_card');
    expect(pending).toMatchObject({ status: 'pending', errorCode: 'discord_503' });
    expect(h.scheduled.at(-1)?.runAt).toBe(wakeSlot(pending.nextAttemptAt));
    expect(h.scheduled).toHaveLength(booked + 1);

    h.respond = () => undefined;
    h.clock = pending.nextAttemptAt;
    await sweep(h);
    expect(h.effect('delete_card').status).toBe('succeeded');
    expect(h.scheduled).toHaveLength(booked + 1);
  });

  test('redraws a card without its answers after the purge', async () => {
    const h = harness();
    await h.submit();
    await sweep(h);
    await h.accept();
    await sweep(h);
    const edits = h.callsOf('edit_message').length;

    off(h);
    h.advance(31 * DAY_MS);
    expect(await h.store.purgeContent(h.clock, 10)).toBe(1);
    await sweep(h);

    expect(h.callsOf('edit_message')).toHaveLength(edits + 1);
    const shown = texts(h.callsOf('edit_message').at(-1)?.payload.components);
    expect(shown).not.toContain('SECRET-ANSWER');
    expect(shown).toContain('The answers were removed');
    expect(h.effect('card').status).toBe('succeeded');
  });

  test('neither reminds reviewers nor expires a question while off', async () => {
    const h = harness();
    await h.submit();
    await sweep(h);
    await h.requestInfo();
    await sweep(h);
    const calls = h.calls.length;

    off(h);
    h.advance(15 * DAY_MS);
    await sweep(h);

    expect((await h.application()).status).toBe('needs_info');
    expect(h.calls.length).toBe(calls);
    expect(h.byKind('reminder')).toEqual([]);
  });
});

describe('the retention purge', () => {
  test('deletes idle drafts and scrubs answers in bounded rounds', async () => {
    const calls: string[] = [];
    let drafts = 2 * PURGE_BATCH + 3;
    let content = PURGE_BATCH;

    const result = await purgeApplications(
      {
        expireIdleDrafts: async (_now, limit) => {
          calls.push('drafts');
          const done = Math.min(limit, drafts);
          drafts -= done;
          return done;
        },
        purgeContent: async (_now, limit) => {
          calls.push('content');
          const done = Math.min(limit, content);
          content -= done;
          return done;
        },
      },
      new Date(0),
    );

    expect(result).toEqual({ drafts: 2 * PURGE_BATCH + 3, purged: PURGE_BATCH });
    expect(calls).toEqual(['drafts', 'drafts', 'drafts', 'content', 'content']);
  });

  test('stops after the round limit even when more is waiting', async () => {
    let rounds = 0;
    const result = await purgeApplications(
      {
        expireIdleDrafts: async (_now, limit) => {
          rounds += 1;
          return limit;
        },
        purgeContent: async () => 0,
      },
      new Date(0),
    );

    expect(rounds).toBe(PURGE_ROUNDS);
    expect(result.drafts).toBe(PURGE_ROUNDS * PURGE_BATCH);
  });

  test('uses the time it is given', async () => {
    const seen: number[] = [];
    await purgeApplications(
      {
        expireIdleDrafts: async (now) => {
          seen.push(now);
          return 0;
        },
        purgeContent: async (now) => {
          seen.push(now);
          return 0;
        },
      },
      new Date(5 * HOUR),
    );

    expect(seen).toEqual([5 * HOUR, 5 * HOUR]);
  });
});
