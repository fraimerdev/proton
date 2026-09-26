import { describe, expect, test } from 'bun:test';
import type { ActionRequest } from '@proton/core';
import { effectProblems } from '../src/card.ts';
import { EFFECT_ATTEMPTS_MAX, REQUEST_ANSWER_TIMEOUT_MS } from '../src/constants.ts';
import { createApplicationsListeners } from '../src/listeners.ts';
import { NO_MUTUAL_SERVER, ONBOARDING_NOTE } from '../src/notify.ts';
import {
  ALREADY_HAD,
  AUDIENCE_UNKNOWN_NOTICE,
  armSweep,
  backoffAt,
  CHANGED,
  DOWNGRADE_NOTICE,
  LEVELING_OFF,
  NO_REVIEW_CHANNEL,
  RANKED_TARGET,
  TICKETS_OFF,
  XP_UNANSWERED,
} from '../src/runner.ts';
import { wakeSlot } from '../src/store.ts';
import {
  ACCEPT_ROLE,
  APP_ID,
  APPLICANT,
  COMPONENTS_V2,
  configWith,
  DASHBOARD,
  DECIDER,
  DM_CHANNEL,
  EffectsHarness,
  failure,
  formConfig,
  GUILD,
  MANAGED_ROLE,
  PING_ROLE,
  PUBLIC_CHANNEL,
  REMOVE_ROLE,
  REVIEW_CHANNEL,
  REVIEW_THREAD,
  REVIEWER,
  SUBMIT_ROLE,
  texts,
} from './effects-harness.ts';

const MINUTE = 60_000;

function harness(form: Parameters<typeof configWith>[1] = {}, settings = {}) {
  return new EffectsHarness(configWith(settings, form));
}

async function listen(h: EffectsHarness, type: string, payload: Record<string, unknown>) {
  const listeners = createApplicationsListeners(h.raw());
  for (const listener of listeners) {
    if (!listener.types.includes(type as never)) continue;
    await listener.handler(
      {
        id: `${type}:${h.calls.length}`,
        type: type as never,
        guildId: GUILD,
        occurredAt: h.clock,
        payload,
      },
      h.ctx,
    );
  }
}

describe('a submission', () => {
  test('posts the card, DMs the receipt, pings, gives the submit role and tells other modules', async () => {
    const h = harness({
      actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } },
      review: { pingRoleIds: [PING_ROLE] },
    });
    const submitted = await h.submit();

    await h.work(APP_ID);

    expect(h.invalid).toEqual([]);
    expect(h.effects().map((effect) => [effect.key, effect.status])).toEqual([
      ['card', 'succeeded'],
      [`submitted:${submitted.revision}:dm`, 'succeeded'],
      [`submitted:${submitted.revision}:ping`, 'succeeded'],
      [`submitted:${submitted.revision}:add_role:${SUBMIT_ROLE}`, 'succeeded'],
      [`event:submitted:${submitted.revision}`, 'succeeded'],
    ]);

    const [card] = h.callsOf('send');
    expect(card?.payload.channelId).toBe(REVIEW_CHANNEL);
    expect(card?.payload.flags).toBe(COMPONENTS_V2);
    expect(card?.payload.allowedMentions).toEqual({ parse: [] });
    expect(card?.payload.content).toBeUndefined();
    expect(card?.request.record).toBe(false);
    expect(card?.key).toBe(`applications:${APP_ID}:card:${submitted.revision}:1`);
    expect(texts(card?.payload.components)).toContain('## Moderator Application #1');

    const application = await h.application();
    expect(application.cardChannelId).toBe(REVIEW_CHANNEL);
    expect(application.cardMessageId).not.toBeNull();
    expect(application.cardRevision).toBe(submitted.revision);
    expect(application.dmChannelId).toBe(DM_CHANNEL);

    const dm = h.callsOf('send').find((call) => call.payload.directMessage === true);
    expect(dm?.payload.channelId).toBe(DM_CHANNEL);
    expect(dm?.payload.allowedMentions).toEqual({ parse: [] });
    expect(dm?.request.record).toBe(false);
    expect(JSON.stringify(dm?.payload)).toContain('#1');
    expect(JSON.stringify(dm?.payload)).toContain('Proton Test');
    expect(h.callsOf('create_dm')[0]?.request.record).toBe(false);

    const ping = h.callsOf('send').find((call) => String(call.payload.content).includes('New'));
    expect(ping?.payload.content).toBe(`<@&${PING_ROLE}> New Moderator Application #1`);
    expect(ping?.payload.allowedMentions).toEqual({ parse: [], roles: [PING_ROLE] });

    const [role] = h.callsOf('add_role');
    expect(role?.request.record).toBe(true);
    expect(role?.request.reason).toBe('Application #1 sent');
    expect(role?.request.actorId).toBe('proton:applications');
    expect(h.roles(APPLICANT)).toEqual([SUBMIT_ROLE]);
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([SUBMIT_ROLE]);

    expect(h.published.map(({ type, naturalKey }) => [type, naturalKey])).toEqual([
      ['applications.submitted', `${APP_ID}:${submitted.revision}`],
    ]);
    expect(h.published[0]?.payload).toMatchObject({
      guildId: GUILD,
      applicationId: APP_ID,
      number: 1,
      status: 'submitted',
      revision: submitted.revision,
    });
  });

  test('never copies an answer into a reason, a ping, an event or a log', async () => {
    const h = harness({
      actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } },
      review: { pingRoleIds: [PING_ROLE] },
    });
    await h.submit();
    await h.work(APP_ID);

    const recorded = h.calls.filter((call) => call.request.record !== false);
    expect(JSON.stringify(recorded)).not.toContain('SECRET-ANSWER');
    expect(JSON.stringify(h.published)).not.toContain('SECRET-ANSWER');
    expect(JSON.stringify(h.logs)).not.toContain('SECRET-ANSWER');
  });

  test('a redelivered run does nothing twice', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    await h.submit();

    await h.work(APP_ID);
    const calls = h.calls.length;
    await h.work(APP_ID);
    await h.work();

    expect(h.calls.length).toBe(calls);
    expect(h.published).toHaveLength(1);
  });
});

describe('the review card', () => {
  test('is edited in place when the application changes', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const posted = (await h.application()).cardMessageId;

    const claimed = await h.claim();
    await h.work(APP_ID);

    const [edit] = h.callsOf('edit_message');
    expect(edit?.payload.messageId).toBe(posted);
    expect(edit?.payload.flags).toBe(COMPONENTS_V2);
    expect(edit?.key).toBe(`applications:${APP_ID}:card-edit:${claimed.revision}`);
    expect(texts(edit?.payload.components)).toContain(`claimed by <@${REVIEWER}>`);
    expect((await h.application()).cardRevision).toBe(claimed.revision);
    expect(h.callsOf('send').filter((call) => call.payload.directMessage !== true)).toHaveLength(1);
  });

  test('a deleted card message is posted again and remembered', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const first = (await h.application()).cardMessageId;

    h.respond = (request) =>
      request.kind === 'edit_message'
        ? failure('discord_404', 'Unknown Message', 10008)
        : undefined;
    await h.claim();
    await h.work(APP_ID);

    const second = (await h.application()).cardMessageId;
    expect(second).not.toBe(first);
    expect(h.effect('card').status).toBe('succeeded');
    expect(h.effect('card').result.messageId).toBe(second);
  });

  test('no review channel leaves the card skipped, not failed', async () => {
    const h = harness();
    await h.submit();
    h.config = configWith({ reviewChannelId: undefined });

    await h.work(APP_ID);

    expect(h.effect('card')).toMatchObject({ status: 'skipped', error: NO_REVIEW_CHANNEL });
    expect(effectProblems(h.effects())).toEqual([]);
  });

  test('full answers are only mirrored into a channel the review team alone can read', async () => {
    const h = harness({ review: { cardAnswers: 'full' } });
    await h.submit();
    await h.work(APP_ID);

    expect(h.effect('card').result).toMatchObject({ mode: 'full' });
    expect(h.effect('card').result.downgraded).toBeUndefined();
    expect(texts(h.callsOf('send')[0]?.payload.components)).toContain('SECRET-ANSWER');
  });

  test('a channel members outside the team can read gets no answers and the warning', async () => {
    const h = harness({ review: { cardAnswers: 'full', channelId: PUBLIC_CHANNEL } });
    await h.submit();
    await h.work(APP_ID);

    expect(h.effect('card').result).toMatchObject({
      mode: 'none',
      downgraded: 'channel_not_private',
    });
    const shown = texts(h.callsOf('send')[0]?.payload.components);
    expect(shown).toContain(DOWNGRADE_NOTICE);
    expect(shown).not.toContain('SECRET-ANSWER');
  });

  test('a summary is held to the same audience check as full answers', async () => {
    const h = harness({ review: { cardAnswers: 'summary', channelId: PUBLIC_CHANNEL } });
    await h.submit();
    await h.work(APP_ID);

    expect(h.effect('card').result).toMatchObject({
      mode: 'none',
      downgraded: 'channel_not_private',
    });
    expect(texts(h.callsOf('send')[0]?.payload.components)).not.toContain('SECRET-ANSWER');
  });

  test('a summary in a channel only the review team can read shows the answers', async () => {
    const h = harness({ review: { cardAnswers: 'summary' } });
    await h.submit();
    await h.work(APP_ID);

    expect(h.effect('card').result).toMatchObject({ mode: 'summary' });
    expect(h.effect('card').result.downgraded).toBeUndefined();
    expect(texts(h.callsOf('send')[0]?.payload.components)).toContain('SECRET-ANSWER');
  });

  test('a card for a removed form is checked against the default team', async () => {
    const h = harness({}, { reviewChannelId: PUBLIC_CHANNEL });
    await h.submit();
    h.config = configWith({ reviewChannelId: PUBLIC_CHANNEL, forms: [] });
    await h.work(APP_ID);

    expect(h.effect('card').result).toMatchObject({
      mode: 'none',
      downgraded: 'channel_not_private',
    });
    expect(texts(h.callsOf('send')[0]?.payload.components)).not.toContain('SECRET-ANSWER');
  });

  test('a thread is judged by the channel it sits in', async () => {
    const h = harness({ review: { cardAnswers: 'full', channelId: REVIEW_THREAD } });
    await h.submit();
    await h.work(APP_ID);

    expect(h.effect('card').result.downgraded).toBe('channel_not_private');
  });

  test('without the server’s cached state the card shows no answers', async () => {
    const h = harness({ review: { cardAnswers: 'full' } });
    h.state = null;
    await h.submit();
    await h.work(APP_ID);

    expect(h.effect('card').result).toMatchObject({
      mode: 'none',
      downgraded: 'audience_unknown',
    });
    const shown = texts(h.callsOf('send')[0]?.payload.components);
    expect(shown).toContain(AUDIENCE_UNKNOWN_NOTICE);
    expect(shown).not.toContain('SECRET-ANSWER');
  });

  test('a repost puts up a new card and removes the old one', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const first = (await h.application()).cardMessageId;

    const now = h.clock;
    await h.store.transition({
      guildId: GUILD,
      applicationId: APP_ID,
      action: 'repost_card',
      actor: { id: REVIEWER, source: 'dashboard' },
      expect: {},
      patch: {},
      event: { kind: 'card_reposted' },
      plan: () => [
        {
          key: 'card',
          kind: 'card',
          trigger: 'repost',
          params: { channelId: REVIEW_CHANNEL, repost: true },
        },
      ],
      now,
    });
    await h.work(APP_ID);

    const second = (await h.application()).cardMessageId;
    expect(second).not.toBe(first);
    expect(h.callsOf('delete_message').map((call) => call.payload.messageId)).toEqual([first]);
  });

  test('an old card that can’t be removed is queued for removal, not forgotten', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const first = (await h.application()).cardMessageId;

    h.respond = (request) =>
      request.kind === 'delete_message'
        ? failure('discord_403', 'Missing Permissions', 50013)
        : undefined;
    await h.store.transition({
      guildId: GUILD,
      applicationId: APP_ID,
      action: 'repost_card',
      actor: { id: REVIEWER, source: 'dashboard' },
      expect: {},
      patch: {},
      event: { kind: 'card_reposted' },
      plan: () => [
        {
          key: 'card',
          kind: 'card',
          trigger: 'repost',
          params: { channelId: REVIEW_CHANNEL, repost: true },
        },
      ],
      now: h.clock,
    });
    await h.work(APP_ID);

    const queued = h.effect(`delete_card:${first}`);
    expect(queued).toMatchObject({
      kind: 'delete_card',
      status: 'pending',
      params: { channelId: REVIEW_CHANNEL, messageId: first },
    });
    expect(h.effect('card').status).toBe('succeeded');

    h.respond = () => undefined;
    await h.work(APP_ID);
    expect(h.effect(`delete_card:${first}`).status).toBe('succeeded');
    expect(h.callsOf('delete_message').map((call) => call.payload.messageId)).toEqual([
      first,
      first,
    ]);
  });

  test('keeps updating through many changes and drops the answers after the purge', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    expect(texts(h.callsOf('send')[0]?.payload.components)).toContain('SECRET-ANSWER');

    for (let change = 0; change < 3; change += 1) {
      h.advance(MINUTE);
      await h.claim();
      await h.work(APP_ID);
      h.advance(MINUTE);
      await h.move({ action: 'claim', lifecycle: null, patch: { assigneeId: null } });
      await h.work(APP_ID);
    }
    h.advance(MINUTE);
    await h.accept();
    await h.work(APP_ID);

    const edits = h.callsOf('edit_message');
    expect(edits.length).toBeGreaterThan(EFFECT_ATTEMPTS_MAX);
    expect(h.effect('card').status).toBe('succeeded');
    expect(texts(edits.at(-1)?.payload.components)).toContain('**Accepted** by');

    h.advance(31 * 24 * 60 * MINUTE);
    expect(await h.store.purgeContent(h.clock, 10)).toBe(1);
    await h.work(APP_ID);

    expect(h.callsOf('edit_message')).toHaveLength(edits.length + 1);
    const scrubbed = texts(h.callsOf('edit_message').at(-1)?.payload.components);
    expect(scrubbed).not.toContain('SECRET-ANSWER');
    expect(scrubbed).toContain('The answers were removed');
    expect(h.effect('card').status).toBe('succeeded');
    expect(h.publishedOf('applications.action_failed')).toEqual([]);
  });

  test('a post tried again after a retry never reuses an earlier key', async () => {
    const h = harness();
    let down = true;
    h.respond = (request) =>
      down &&
      request.kind === 'send' &&
      !(request.payload as { directMessage?: boolean }).directMessage
        ? failure('discord_503', 'Discord is having trouble.')
        : undefined;
    await h.submit();
    await h.work(APP_ID);
    for (let attempt = 2; attempt <= EFFECT_ATTEMPTS_MAX; attempt += 1) {
      h.clock = h.effect('card').nextAttemptAt;
      await h.work(APP_ID);
    }
    expect(h.effect('card').status).toBe('failed');

    down = false;
    await h.store.retryEffect(GUILD, APP_ID, h.effect('card').id, {
      id: REVIEWER,
      source: 'dashboard',
    });
    await h.work(APP_ID);

    expect(h.effect('card').status).toBe('succeeded');
    const keys = h
      .callsOf('send')
      .filter((call) => call.payload.directMessage !== true)
      .map((call) => call.key);
    expect(keys).toHaveLength(EFFECT_ATTEMPTS_MAX + 1);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a card posted while the application is being deleted is taken down again', async () => {
    const h = harness();
    await h.submit();
    h.respond = (request) => {
      if (request.kind === 'send' && request.idempotencyKey.includes(':card:')) {
        void h.store.deleteApplication({
          guildId: GUILD,
          applicationId: APP_ID,
          actor: { id: DECIDER, source: 'dashboard' },
          audit: {
            actorId: DECIDER,
            source: 'dashboard',
            action: 'module.applications.delete',
            id: 'audit-race',
          },
        });
      }
      return undefined;
    };
    await h.work(APP_ID);

    const [posted] = h.calls.filter((call) => call.kind === 'send' && call.key.includes(':card:'));
    const postedId = (posted?.result.body as { id?: string } | undefined)?.id;
    expect(postedId).toBeString();
    expect(h.callsOf('delete_message').map((call) => call.payload.messageId)).toEqual([postedId]);
    expect((await h.application()).cardMessageId).toBeNull();
    expect(h.byKind('delete_card')).toEqual([]);
  });
});

describe('DMs', () => {
  test('closed DMs fail only the DM, visibly, and the rest goes ahead', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    h.respond = (request) =>
      request.kind === 'send' && (request.payload as { directMessage?: boolean }).directMessage
        ? failure('discord_403', 'Cannot send messages to this user', 50007)
        : undefined;

    const submitted = await h.submit();
    await h.work(APP_ID);

    const dm = h.effect(`submitted:${submitted.revision}:dm`);
    expect(dm).toMatchObject({
      status: 'failed',
      errorCode: 'dms_closed',
      error: 'Couldn’t DM the applicant: their DMs are closed to Proton.',
    });
    expect(h.effect(`submitted:${submitted.revision}:add_role:${SUBMIT_ROLE}`).status).toBe(
      'succeeded',
    );
    expect((await h.application()).status).toBe('submitted');
    expect(effectProblems(h.effects()).map((problem) => problem.label)).toEqual([
      'DM not delivered',
    ]);

    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);
    expect(h.publishedOf('applications.action_failed')[0]).toMatchObject({
      naturalKey: `${dm.id}:${dm.updatedAt}`,
      payload: { effectId: dm.id, kind: 'dm', errorCode: 'dms_closed', number: 1 },
    });

    await h.work(APP_ID);
    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);
  });

  test('a DM that fails again after a retry is reported again', async () => {
    const h = harness();
    h.respond = (request) =>
      request.kind === 'send' && (request.payload as { directMessage?: boolean }).directMessage
        ? failure('discord_403', 'Cannot send messages to this user', 50007)
        : undefined;
    const submitted = await h.submit();
    await h.work(APP_ID);

    const key = `submitted:${submitted.revision}:dm`;
    h.advance(MINUTE);
    await h.store.retryEffect(GUILD, APP_ID, h.effect(key).id, {
      id: REVIEWER,
      source: 'dashboard',
    });
    await h.work(APP_ID);

    expect(h.effect(key).status).toBe('failed');
    const reported = h.publishedOf('applications.action_failed');
    expect(reported).toHaveLength(2);
    expect(new Set(reported.map((entry) => entry.naturalKey)).size).toBe(2);
  });

  test('a retry after the member opens their DMs runs only the failed DM', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    let closed = true;
    h.respond = (request) =>
      closed &&
      request.kind === 'send' &&
      (request.payload as { directMessage?: boolean }).directMessage
        ? failure('discord_403', 'Cannot send messages to this user', 50007)
        : undefined;

    const submitted = await h.submit();
    await h.work(APP_ID);
    const before = h.calls.length;

    closed = false;
    const dm = h.effect(`submitted:${submitted.revision}:dm`);
    await h.store.retryEffect(GUILD, APP_ID, dm.id, { id: REVIEWER, source: 'dashboard' });
    await h.work(APP_ID);

    const after = h.calls.slice(before);
    expect(after.map((call) => call.kind)).toEqual(['send', 'edit_message']);
    expect(after[0]?.payload.directMessage).toBe(true);
    expect(h.effect(`submitted:${submitted.revision}:dm`).status).toBe('succeeded');
    expect(h.callsOf('add_role')).toHaveLength(1);
  });

  test('no shared server is its own failure', async () => {
    const h = harness();
    h.respond = (request) =>
      request.kind === 'send' && (request.payload as { directMessage?: boolean }).directMessage
        ? failure('discord_400', 'no mutual guilds', 50278)
        : undefined;
    const submitted = await h.submit();
    await h.work(APP_ID);

    expect(h.effect(`submitted:${submitted.revision}:dm`)).toMatchObject({
      status: 'failed',
      errorCode: 'no_mutual_server',
      error: NO_MUTUAL_SERVER,
    });
  });

  test('a DM that may have landed is retried with backoff, then reported unconfirmed', async () => {
    const h = harness();
    h.respond = (request) =>
      request.kind === 'send' && (request.payload as { directMessage?: boolean }).directMessage
        ? failure('transport_failure', 'Couldn’t reach Discord')
        : undefined;
    const submitted = await h.submit();
    const key = `submitted:${submitted.revision}:dm`;

    await h.work(APP_ID);
    expect(h.effect(key)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(h.effect(key).nextAttemptAt).toBe(backoffAt(h.clock, 1));
    expect(h.effect(key).nextAttemptAt - h.clock).toBe(2 * MINUTE);

    for (let attempt = 2; attempt <= EFFECT_ATTEMPTS_MAX; attempt += 1) {
      h.clock = h.effect(key).nextAttemptAt;
      await h.work(APP_ID);
    }

    expect(h.effect(key)).toMatchObject({
      status: 'failed',
      attempts: EFFECT_ATTEMPTS_MAX,
      errorCode: 'unconfirmed',
      error: 'Proton couldn’t confirm the DM reached the applicant.',
    });
    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);
  });

  test('backoff doubles and stops growing at half an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => backoffAt(0, n) / MINUTE)).toEqual([
      2, 4, 8, 16, 30, 30, 30,
    ]);
  });

  test('the decision DM carries the reason and the decider', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const accepted = await h.accept('You were great.');
    await h.work(APP_ID);

    const dm = h
      .callsOf('send')
      .filter((call) => call.payload.directMessage === true)
      .at(-1);
    expect(h.effect(`accepted:${accepted.revision}:dm`).status).toBe('succeeded');
    expect(JSON.stringify(dm?.payload)).toContain('You were great.');
    expect(JSON.stringify(dm?.payload)).toContain('Application accepted');
    expect(JSON.stringify(dm?.payload)).not.toContain(ONBOARDING_NOTE);
    expect(h.callsOf('create_dm')).toHaveLength(1);
  });

  test('turning DMs off for the form skips a queued one', async () => {
    const h = harness();
    const submitted = await h.submit();
    h.config = configWith({}, { notify: { dm: false } });
    await h.work(APP_ID);

    expect(h.effect(`submitted:${submitted.revision}:dm`).status).toBe('skipped');
    expect(h.callsOf('create_dm')).toEqual([]);
  });
});

describe('roles', () => {
  test('a role the member already had is skipped and never recorded as granted', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    h.give(APPLICANT, SUBMIT_ROLE);
    const submitted = await h.submit();
    await h.work(APP_ID);

    expect(h.effect(`submitted:${submitted.revision}:add_role:${SUBMIT_ROLE}`)).toMatchObject({
      status: 'skipped',
      error: ALREADY_HAD,
    });
    expect(h.callsOf('add_role')).toEqual([]);

    const rejected = await h.reject();
    await h.work(APP_ID);

    expect(h.effect(`rejected:${rejected.revision}:cleanup`).status).toBe('skipped');
    expect(h.callsOf('remove_role')).toEqual([]);
    expect(h.roles(APPLICANT)).toEqual([SUBMIT_ROLE]);
  });

  test('closing takes back only the roles this application gave', async () => {
    const h = harness({
      actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] }, onAccept: { addRoleIds: [ACCEPT_ROLE] } },
    });
    await h.submit();
    await h.work(APP_ID);
    const accepted = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:cleanup`).status).toBe('succeeded');
    expect(h.callsOf('remove_role').map((call) => call.payload.roleId)).toEqual([SUBMIT_ROLE]);
    expect(h.callsOf('remove_role')[0]?.request.reason).toBe('Application #1 accepted');
    expect(h.roles(APPLICANT)).toEqual([ACCEPT_ROLE]);
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([ACCEPT_ROLE]);
  });

  test('a hierarchy refusal leaves the application accepted with a role problem to retry', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);

    let refuse = true;
    h.respond = (request) =>
      refuse && request.kind === 'add_role'
        ? failure(
            'role_hierarchy',
            `<@&${ACCEPT_ROLE}> sits above Proton's highest role, so Proton can't give it.`,
          )
        : undefined;

    const accepted = await h.accept();
    await h.work(APP_ID);

    const role = h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`);
    expect(role).toMatchObject({ status: 'failed', errorCode: 'role_hierarchy' });
    expect(role.error).toContain(`<@&${ACCEPT_ROLE}>`);
    expect((await h.application()).status).toBe('accepted');
    expect(h.effect(`accepted:${accepted.revision}:dm`).status).toBe('succeeded');
    const decisionDm = h
      .callsOf('send')
      .filter((call) => call.payload.directMessage === true)
      .at(-1);
    expect(String(decisionDm?.payload.content)).toContain(ONBOARDING_NOTE);
    expect(effectProblems(h.effects()).map((problem) => problem.label)).toEqual([
      'Role update failed',
    ]);

    const refreshed = h.callsOf('edit_message').at(-1);
    expect(refreshed?.key).toBe(`applications:${APP_ID}:card-refresh:problem:${role.id}:1`);
    expect(texts(refreshed?.payload.components)).toContain('**Accepted** by');
    expect(texts(refreshed?.payload.components)).toContain('Needs attention:** Role update failed');

    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);

    refuse = false;
    const before = h.calls.length;
    const dms = h.callsOf('send').length;
    await h.store.retryEffect(GUILD, APP_ID, role.id, { id: REVIEWER, source: 'dashboard' });
    await h.work(APP_ID);

    const after = h.calls.slice(before);
    expect(after.map((call) => call.kind)).toEqual(['add_role', 'edit_message']);
    expect(texts(after[1]?.payload.components)).not.toContain('Needs attention');
    expect(h.callsOf('send')).toHaveLength(dms);
    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`).status).toBe(
      'succeeded',
    );
    expect(h.roles(APPLICANT)).toEqual([ACCEPT_ROLE]);
  });

  test('roles that all land keep the acceptance DM free of the setup note', async () => {
    const h = harness({
      actions: { onAccept: { addRoleIds: [ACCEPT_ROLE], removeRoleIds: [REMOVE_ROLE] } },
    });
    h.give(APPLICANT, REMOVE_ROLE);
    await h.submit();
    await h.work(APP_ID);
    const accepted = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`).status).toBe(
      'succeeded',
    );
    expect(h.effect(`accepted:${accepted.revision}:remove_role:${REMOVE_ROLE}`).status).toBe(
      'succeeded',
    );
    const dm = h
      .callsOf('send')
      .filter((call) => call.payload.directMessage === true)
      .at(-1);
    expect(JSON.stringify(dm?.payload)).not.toContain(ONBOARDING_NOTE);
  });

  test('a member ranked above Proton gets the plain explanation', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    h.respond = (request) =>
      request.kind === 'add_role'
        ? failure('role_hierarchy', 'That member is ranked at or above Proton.')
        : undefined;
    await h.submit();
    const accepted = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`).error).toBe(
      RANKED_TARGET,
    );
  });

  test('a managed role is refused before Discord is asked', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [MANAGED_ROLE] } } });
    await h.submit();
    const accepted = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:add_role:${MANAGED_ROLE}`)).toMatchObject({
      status: 'failed',
      errorCode: 'managed',
    });
    expect(h.callsOf('add_role')).toEqual([]);
  });

  test('a member who left fails the grant and skips the removal', async () => {
    const h = harness({
      actions: { onAccept: { addRoleIds: [ACCEPT_ROLE], removeRoleIds: [REMOVE_ROLE] } },
    });
    await h.submit();
    h.absent.add(APPLICANT);
    const accepted = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`)).toMatchObject({
      status: 'failed',
      errorCode: 'target_not_member',
    });
    expect(h.effect(`accepted:${accepted.revision}:remove_role:${REMOVE_ROLE}`).status).toBe(
      'skipped',
    );
  });

  test('roles that can’t be read wait instead of guessing', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    await h.submit();
    h.rolesUnknown = true;
    const accepted = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`)).toMatchObject({
      status: 'pending',
      errorCode: 'member_unavailable',
    });
    expect(h.callsOf('add_role')).toEqual([]);
  });

  test('a duplicate key is confirmed from the member’s roles, never assumed', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    await h.submit();
    const accepted = await h.accept();
    const key = `accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`;

    h.respond = (request) =>
      request.kind === 'add_role' ? { status: 'skipped_duplicate' } : undefined;
    await h.work(APP_ID);
    expect(h.effect(key)).toMatchObject({ status: 'pending', errorCode: 'unconfirmed' });

    h.give(APPLICANT, ACCEPT_ROLE);
    h.clock = h.effect(key).nextAttemptAt;
    await h.work(APP_ID);
    expect(h.effect(key).status).toBe('succeeded');
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([ACCEPT_ROLE]);
  });

  test('a role taken out of the form’s outcome is not given', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    await h.submit();
    const accepted = await h.accept();
    h.config = configWith({}, { actions: { onAccept: { addRoleIds: [] } } });
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`).status).toBe(
      'skipped',
    );
    expect(h.callsOf('add_role')).toEqual([]);
  });

  test('a role that landed despite a server error is recorded, so closing takes it back', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    let first = true;
    h.respond = (request) => {
      if (request.kind !== 'add_role' || !first) return undefined;
      first = false;
      h.give(APPLICANT, SUBMIT_ROLE);
      return failure('discord_502', 'Discord had a problem.');
    };
    const submitted = await h.submit();
    const key = `submitted:${submitted.revision}:add_role:${SUBMIT_ROLE}`;

    await h.work(APP_ID);
    expect(h.effect(key)).toMatchObject({ status: 'pending', errorCode: 'discord_502' });
    h.clock = h.effect(key).nextAttemptAt;
    await h.work(APP_ID);

    expect(h.effect(key)).toMatchObject({ status: 'succeeded', result: { granted: true } });
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([SUBMIT_ROLE]);

    const rejected = await h.reject();
    await h.work(APP_ID);
    expect(h.effect(`rejected:${rejected.revision}:cleanup`).status).toBe('succeeded');
    expect(h.roles(APPLICANT)).toEqual([]);
  });

  test('a role found only after the member’s roles couldn’t be read is not claimed', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    h.rolesUnknown = true;
    const submitted = await h.submit();
    const key = `submitted:${submitted.revision}:add_role:${SUBMIT_ROLE}`;
    await h.work(APP_ID);
    expect(h.effect(key).errorCode).toBe('member_unavailable');

    h.rolesUnknown = false;
    h.give(APPLICANT, SUBMIT_ROLE);
    h.clock = h.effect(key).nextAttemptAt;
    await h.work(APP_ID);

    expect(h.effect(key)).toMatchObject({ status: 'skipped', error: ALREADY_HAD });
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([]);
  });
});

describe('a submit role two open applications share', () => {
  const OTHER_APP = '01JAPPLICATION00000000000B';

  function shared(events: Parameters<typeof formConfig>[0]) {
    return new EffectsHarness(
      configWith({
        forms: [
          formConfig({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } }),
          formConfig({ id: 'events', name: 'Event Staff', ...events }),
        ],
      }),
    );
  }

  test('stays while the other still needs it and goes with the last one', async () => {
    const h = shared({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);
    const other = await h.submit({ id: OTHER_APP, formId: 'events' });
    await h.work(OTHER_APP);

    expect(
      h.effect(`submitted:${other.revision}:add_role:${SUBMIT_ROLE}`, OTHER_APP),
    ).toMatchObject({ status: 'succeeded', result: { sharedWith: APP_ID } });
    expect(h.callsOf('add_role')).toHaveLength(1);

    const rejected = await h.reject();
    await h.work(APP_ID);

    expect(h.effect(`rejected:${rejected.revision}:cleanup`)).toMatchObject({
      status: 'succeeded',
      result: { removed: [], kept: [SUBMIT_ROLE] },
    });
    expect(h.callsOf('remove_role')).toEqual([]);
    expect(h.roles(APPLICANT)).toEqual([SUBMIT_ROLE]);
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([]);
    expect(await h.store.grantedRoles(GUILD, OTHER_APP)).toEqual([SUBMIT_ROLE]);

    await h.reject(OTHER_APP);
    await h.work(OTHER_APP);
    expect(h.callsOf('remove_role').map((call) => call.payload.roleId)).toEqual([SUBMIT_ROLE]);
    expect(h.roles(APPLICANT)).toEqual([]);
  });

  test('is handed on when the first closes before the second’s grant has run', async () => {
    const h = shared({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);
    const other = await h.submit({ id: OTHER_APP, formId: 'events' });

    await h.reject();
    await h.work(APP_ID);
    expect(await h.store.grantedRoles(GUILD, OTHER_APP)).toEqual([SUBMIT_ROLE]);
    expect(h.roles(APPLICANT)).toEqual([SUBMIT_ROLE]);

    await h.work(OTHER_APP);
    expect(h.effect(`submitted:${other.revision}:add_role:${SUBMIT_ROLE}`, OTHER_APP).status).toBe(
      'succeeded',
    );

    await h.reject(OTHER_APP);
    await h.work(OTHER_APP);
    expect(h.roles(APPLICANT)).toEqual([]);
  });

  test('stays when another application’s decision gives the same role', async () => {
    const h = shared({ actions: { onAccept: { addRoleIds: [SUBMIT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);
    await h.submit({ id: OTHER_APP, formId: 'events' });
    await h.work(OTHER_APP);
    await h.accept('Welcome aboard.', OTHER_APP);
    await h.work(OTHER_APP);

    await h.reject();
    await h.work(APP_ID);

    expect(h.callsOf('remove_role')).toEqual([]);
    expect(h.roles(APPLICANT)).toEqual([SUBMIT_ROLE]);
  });
});

describe('reconciling queued work', () => {
  test('a reopen before the decision’s DM and roles ran skips them, and the events still go out', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);

    const accepted = await h.accept();
    await h.reopen();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${accepted.revision}:dm`)).toMatchObject({
      status: 'skipped',
      error: CHANGED,
    });
    expect(h.effect(`accepted:${accepted.revision}:add_role:${ACCEPT_ROLE}`).status).toBe(
      'skipped',
    );
    expect(h.callsOf('add_role')).toEqual([]);
    expect(h.published.map((entry) => entry.type)).toEqual([
      'applications.submitted',
      'applications.accepted',
      'applications.reopened',
    ]);
  });

  test('accepting again after a reopen sends one decision, not two', async () => {
    const h = harness({ actions: { onAccept: { addRoleIds: [ACCEPT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);

    const first = await h.accept();
    await h.reopen();
    const second = await h.accept();
    await h.work(APP_ID);

    expect(h.effect(`accepted:${first.revision}:dm`).status).toBe('skipped');
    expect(h.effect(`accepted:${second.revision}:dm`).status).toBe('succeeded');
    expect(h.callsOf('add_role')).toHaveLength(1);
    const decisionDms = h
      .callsOf('send')
      .filter((call) => JSON.stringify(call.payload).includes('Application accepted'));
    expect(decisionDms).toHaveLength(1);
  });

  test('claiming keeps the receipt going: it is still an open application', async () => {
    const h = harness();
    const submitted = await h.submit();
    await h.claim();
    await h.work(APP_ID);

    expect(h.effect(`submitted:${submitted.revision}:dm`).status).toBe('succeeded');
  });

  test('the information request DM quotes what staff asked', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const asked = await h.requestInfo('Which timezone are you in?');
    await h.work(APP_ID);

    expect(h.effect(`info:${asked.revision}:dm`).status).toBe('succeeded');
    const dm = h
      .callsOf('send')
      .filter((call) => call.payload.directMessage === true)
      .at(-1);
    expect(JSON.stringify(dm?.payload)).toContain('Which timezone are you in?');
  });
});

describe('XP', () => {
  test('is asked of Leveling once, confirmed by its answer, and not given twice', async () => {
    const h = harness({ actions: { onAccept: { xp: 250 } } });
    await h.submit();
    await h.accept();
    await h.work(APP_ID);

    expect(h.effect('accepted:xp').status).toBe('requested');
    const [asked] = h.publishedOf('xp.grant_requested');
    const grantId = `applications:${GUILD}:${APP_ID}:accepted`;
    expect(asked?.payload).toMatchObject({
      guildId: GUILD,
      userId: APPLICANT,
      grantId,
      amount: 250,
      sourceModule: 'applications',
      causation: { kind: 'reward', rootId: `applications:${GUILD}:${APP_ID}`, depth: 0, grantId },
    });
    expect(asked?.payload.originChannelId).toBeUndefined();

    const answer = {
      guildId: GUILD,
      userId: APPLICANT,
      grantId,
      sourceModule: 'applications',
      status: 'granted',
      amount: 250,
    };
    await listen(h, 'xp.granted', answer);
    await listen(h, 'xp.granted', answer);
    expect(h.effect('accepted:xp').status).toBe('succeeded');

    h.advance(REQUEST_ANSWER_TIMEOUT_MS * 3);
    await h.work(APP_ID);
    expect(h.publishedOf('xp.grant_requested')).toHaveLength(1);
  });

  test('an unanswered request is asked again with the same grant, then given up on', async () => {
    const h = harness({ actions: { onAccept: { xp: 100 } } });
    await h.submit();
    await h.accept();
    await h.work(APP_ID);

    for (let ask = 2; ask <= EFFECT_ATTEMPTS_MAX; ask += 1) {
      h.advance(REQUEST_ANSWER_TIMEOUT_MS);
      await h.work(APP_ID);
    }
    const asks = h.publishedOf('xp.grant_requested');
    expect(asks).toHaveLength(EFFECT_ATTEMPTS_MAX);
    expect(new Set(asks.map((ask) => ask.payload.grantId)).size).toBe(1);
    expect(new Set(asks.map((ask) => ask.naturalKey)).size).toBe(EFFECT_ATTEMPTS_MAX);

    h.advance(REQUEST_ANSWER_TIMEOUT_MS);
    await h.work(APP_ID);
    expect(h.effect('accepted:xp')).toMatchObject({ status: 'failed', error: XP_UNANSWERED });
  });

  test('a refusal is a visible failure', async () => {
    const h = harness({ actions: { onAccept: { xp: 100 } } });
    await h.submit();
    await h.accept();
    await h.work(APP_ID);

    await listen(h, 'xp.granted', {
      guildId: GUILD,
      userId: APPLICANT,
      grantId: `applications:${GUILD}:${APP_ID}:accepted`,
      sourceModule: 'applications',
      status: 'refused',
      amount: 0,
      reason: 'Leveling is off in this server.',
    });

    expect(h.effect('accepted:xp')).toMatchObject({ status: 'failed', errorCode: 'xp_refused' });
    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);
  });

  test('Leveling switched off fails the reward without asking', async () => {
    const h = harness({ actions: { onAccept: { xp: 100 } } });
    h.modules.set('leveling', false);
    await h.submit();
    await h.accept();
    await h.work(APP_ID);

    expect(h.effect('accepted:xp')).toMatchObject({ status: 'failed', error: LEVELING_OFF });
    expect(h.publishedOf('xp.grant_requested')).toEqual([]);
  });

  test('a reward still owed across a reopen and a second accept is asked for', async () => {
    const h = harness({ actions: { onAccept: { xp: 50 } } });
    await h.submit();
    await h.work(APP_ID);
    await h.accept();
    await h.reopen();
    await h.accept();
    await h.work(APP_ID);

    expect(h.effect('accepted:xp').status).toBe('requested');
    expect(h.publishedOf('xp.grant_requested')).toHaveLength(1);
  });

  test('a reward retried after a reopen and a second accept is asked for', async () => {
    const h = harness({ actions: { onAccept: { xp: 50 } } });
    h.modules.set('leveling', false);
    await h.submit();
    await h.work(APP_ID);
    await h.accept();
    await h.work(APP_ID);
    await h.reopen();
    await h.work(APP_ID);
    await h.accept();
    await h.work(APP_ID);
    expect(h.effect('accepted:xp')).toMatchObject({ status: 'failed', error: LEVELING_OFF });

    h.modules.set('leveling', true);
    await h.store.retryEffect(GUILD, APP_ID, h.effect('accepted:xp').id, {
      id: REVIEWER,
      source: 'dashboard',
    });
    await h.work(APP_ID);

    expect(h.effect('accepted:xp').status).toBe('requested');
    expect(h.publishedOf('xp.grant_requested')).toHaveLength(1);
  });
});

describe('interview tickets', () => {
  test('asks Tickets with applicant-visible context only and records the answer', async () => {
    const h = harness({ interview: { ticketTypeId: 'interview' } });
    await h.submit();
    await h.work(APP_ID);
    await h.openTicket();
    await h.work(APP_ID);

    const [ticket] = h.byKind('ticket');
    expect(ticket?.status).toBe('requested');
    const [asked] = h.publishedOf('tickets.open_requested');
    expect(asked?.payload).toMatchObject({
      guildId: GUILD,
      requestId: ticket?.id,
      sourceModule: 'applications',
      sourceRef: APP_ID,
      typeId: 'interview',
      ownerId: APPLICANT,
      requestedById: REVIEWER,
      participantIds: [REVIEWER],
    });
    const context = (asked?.payload.context ?? []) as { label: string }[];
    expect(context.map((entry) => entry.label)).toEqual(['Application', 'Reference', 'Submitted']);
    expect(JSON.stringify(asked?.payload)).not.toContain('SECRET-ANSWER');

    const answer = {
      guildId: GUILD,
      requestId: ticket?.id,
      sourceModule: 'applications',
      sourceRef: APP_ID,
      status: 'opened',
      ticketId: 'ticket-1',
      number: 7,
      channelId: '700000000000000001',
    };
    await listen(h, 'tickets.open_answered', answer);
    await listen(h, 'tickets.open_answered', answer);

    expect(h.byKind('ticket')[0]?.status).toBe('succeeded');
    const application = await h.application();
    expect(application.interviewTicketId).toBe('ticket-1');
    expect(application.interviewChannelId).toBe('700000000000000001');
    expect(texts(h.callsOf('edit_message').at(-1)?.payload.components)).toContain(
      'Interview ticket: <#700000000000000001>',
    );

    h.advance(REQUEST_ANSWER_TIMEOUT_MS * 2);
    await h.work(APP_ID);
    expect(h.publishedOf('tickets.open_requested')).toHaveLength(1);
  });

  test('an unanswered request asks again under the same request id', async () => {
    const h = harness({ interview: { ticketTypeId: 'interview' } });
    await h.submit();
    await h.openTicket();
    await h.work(APP_ID);
    h.advance(REQUEST_ANSWER_TIMEOUT_MS);
    await h.work(APP_ID);

    const asks = h.publishedOf('tickets.open_requested');
    expect(asks).toHaveLength(2);
    expect(asks[0]?.payload.requestId).toBe(asks[1]?.payload.requestId);
  });

  test('a refusal carries Tickets’ reason', async () => {
    const h = harness({ interview: { ticketTypeId: 'interview' } });
    await h.submit();
    await h.openTicket();
    await h.work(APP_ID);
    const [ticket] = h.byKind('ticket');

    await listen(h, 'tickets.open_answered', {
      guildId: GUILD,
      requestId: ticket?.id,
      sourceModule: 'applications',
      sourceRef: APP_ID,
      status: 'refused',
      reason: 'There’s no ticket type with the ID “interview”.',
    });

    expect(h.byKind('ticket')[0]).toMatchObject({
      status: 'failed',
      errorCode: 'ticket_refused',
      error: 'There’s no ticket type with the ID “interview”.',
    });
    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);
  });

  test('Tickets switched off fails without asking', async () => {
    const h = harness({ interview: { ticketTypeId: 'interview' } });
    h.modules.set('tickets', false);
    await h.submit();
    await h.openTicket();
    await h.work(APP_ID);

    expect(h.byKind('ticket')[0]).toMatchObject({ status: 'failed', error: TICKETS_OFF });
    expect(h.publishedOf('tickets.open_requested')).toEqual([]);
  });
});

describe('deleting', () => {
  test('removes the card, and a card already gone counts as removed', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    const { cardMessageId } = await h.application();

    h.respond = (request) =>
      request.kind === 'delete_message'
        ? failure('discord_404', 'Unknown Message', 10008)
        : undefined;
    await h.store.deleteApplication({
      guildId: GUILD,
      applicationId: APP_ID,
      actor: { id: DECIDER, source: 'dashboard' },
      audit: {
        actorId: DECIDER,
        source: 'dashboard',
        action: 'module.applications.delete',
        id: 'audit-1',
      },
    });
    await h.work(APP_ID);

    expect(h.effect('delete_card')).toMatchObject({ status: 'succeeded' });
    expect(h.effect('delete_card').result.alreadyGone).toBe(true);
    expect(h.callsOf('delete_message')[0]?.payload.messageId).toBe(cardMessageId);
  });

  test('takes back the submit role Proton gave an open application', async () => {
    const h = harness({ actions: { onSubmit: { addRoleIds: [SUBMIT_ROLE] } } });
    await h.submit();
    await h.work(APP_ID);
    expect(h.roles(APPLICANT)).toEqual([SUBMIT_ROLE]);

    await h.store.deleteApplication({
      guildId: GUILD,
      applicationId: APP_ID,
      actor: { id: DECIDER, source: 'dashboard' },
      audit: {
        actorId: DECIDER,
        source: 'dashboard',
        action: 'module.applications.delete',
        id: 'audit-2',
      },
      cleanup: (application, revision) => [
        {
          key: `delete:${revision}:cleanup`,
          kind: 'remove_role',
          trigger: 'delete',
          params: { fromGrants: true, roleIds: [SUBMIT_ROLE], userId: application.applicantId },
        },
      ],
    });
    await h.work(APP_ID);

    const [cleanup] = h.byKind('remove_role');
    expect(cleanup?.status).toBe('succeeded');
    expect(h.callsOf('remove_role')[0]?.request.reason).toBe('Application #1 deleted');
    expect(h.roles(APPLICANT)).toEqual([]);
    expect(await h.store.grantedRoles(GUILD, APP_ID)).toEqual([]);
  });
});

describe('while the module is off', () => {
  test('nothing runs and nothing is lost', async () => {
    const h = harness();
    await h.submit();
    h.config = { ...h.config, enabled: false };
    await h.work(APP_ID);

    expect(h.calls).toEqual([]);
    expect(h.effects().every((effect) => effect.status === 'pending')).toBe(true);

    h.config = { ...h.config, enabled: true };
    await h.work(APP_ID);
    expect(h.effects().every((effect) => effect.status === 'succeeded')).toBe(true);
  });
});

describe('transient failures', () => {
  test('back off, and stop at the attempt limit with a visible failure', async () => {
    const h = harness();
    h.respond = (request: ActionRequest) =>
      request.kind === 'send' && !(request.payload as { directMessage?: boolean }).directMessage
        ? failure('discord_503', 'Discord is having trouble.')
        : undefined;
    await h.submit();

    await h.work(APP_ID);
    expect(h.effect('card')).toMatchObject({
      status: 'pending',
      attempts: 1,
      errorCode: 'discord_503',
    });

    for (let attempt = 2; attempt <= EFFECT_ATTEMPTS_MAX; attempt += 1) {
      h.clock = h.effect('card').nextAttemptAt;
      await h.work(APP_ID);
    }
    expect(h.effect('card')).toMatchObject({ status: 'failed', attempts: EFFECT_ATTEMPTS_MAX });
    expect(h.publishedOf('applications.action_failed')).toHaveLength(1);
  });
});

describe('arming the sweep', () => {
  test('books a future slot the store’s own wake rows share', async () => {
    const h = harness();
    await armSweep(h.ctx, h.clock);

    const slot = wakeSlot(h.clock);
    expect(h.scheduled).toEqual([{ jobId: 'sweep', runAt: slot, naturalKey: `wake:${slot}` }]);
    expect(slot).toBeGreaterThan(h.clock);
  });
});

describe('the status page link', () => {
  test('points the applicant at their application on the dashboard', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);

    const dm = h.callsOf('send').find((call) => call.payload.directMessage === true);
    expect(JSON.stringify(dm?.payload)).toContain(`${DASHBOARD}/applications/${GUILD}/${APP_ID}`);
  });
});
