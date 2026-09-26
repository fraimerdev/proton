import { describe, expect, test } from 'bun:test';
import {
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_UPDATE,
  INTERACTION_CALLBACK_MODAL,
  Permissions,
} from '@proton/core';
import {
  CARD_LOCK_TTL_MS,
  cardLockKey,
  createReportSubmittedListener,
  deliverCard,
  handleCardDeleted,
  RATE_LIMITED,
  refreshCard,
  runDeliveryPatrol,
} from '../src/reports/delivery.ts';
import { createReportRequestListener } from '../src/reports/requests.ts';
import {
  acceptReport,
  acceptRoot,
  DECISION_STALE_MS,
  deciding,
  dismissReport,
  STILL_OPEN,
  stillSettling,
} from '../src/reports/review.ts';
import { CARD_ATTEMPTS_MAX, cardBackoffMs } from '../src/reports/store.ts';
import { moderationEvent, rawMessage, reactionEvent } from './drivers.ts';
import {
  CHANNEL,
  discordError,
  dmChannelFor,
  HIGH_ROLE,
  LOW_ROLE,
  MESSAGE,
  MOD_ROLE,
  OWNER,
} from './harness.ts';
import { MemoryCaseMessageStore } from './punish-stores.ts';
import {
  actionsOf,
  embedOf,
  fieldValue,
  GUILD,
  MEMBER,
  MODERATOR,
  REPORT_CHANNEL,
  REPORTER,
  REVIEWER_PERMISSIONS,
  type ReviewRig,
  reviewRig,
  SECOND_MODERATOR,
} from './reports-review-setup.ts';
import { reportsInput, textOf } from './reports-setup.ts';

const REVIEWER_ROLE = HIGH_ROLE;

function lastFollowUp(rig: ReviewRig) {
  const message = rig.h.followUps().at(-1);
  if (!message) throw new Error('nothing was followed up');
  return message;
}

function eventKinds(rig: ReviewRig, reportId: string): string[] {
  return [...rig.store.events.values()]
    .filter((event) => event.reportId === reportId)
    .map((event) => event.kind);
}

function actor(overrides: Partial<Parameters<typeof acceptReport>[2]['actor']> = {}) {
  return {
    id: MODERATOR,
    roleIds: [MOD_ROLE],
    permissions: REVIEWER_PERMISSIONS,
    source: 'discord' as const,
    ...overrides,
  };
}

describe('card delivery', () => {
  test('a filed report posts one card with the notify pings, then forwards the message', async () => {
    const rig = reviewRig({ reports: { notifyRoleIds: [LOW_ROLE] } });
    const report = await rig.file();

    const [card, again] = rig.cardPosts();
    expect(again).toBeUndefined();
    expect(card?.content).toBe(`<@&${LOW_ROLE}>`);
    expect(card?.allowed_mentions).toEqual({ parse: [], roles: [LOW_ROLE] });
    expect(embedOf(card).title).toBe(`Report \`${report.id}\` · #${report.number}`);
    expect(actionsOf(card ?? {})).toEqual([
      'rclaim',
      'raccept',
      'rdismiss',
      'rmember',
      'revidence',
    ]);

    const forwards = rig.h.sentIn(REPORT_CHANNEL).filter((message) => message.message_reference);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]?.message_reference).toMatchObject({
      type: 1,
      message_id: report.sourceMessageId,
    });

    expect(report.card.state).toBe('posted');
    expect(report.card.channelId).toBe(REPORT_CHANNEL);
    expect(report.evidence.copy).toMatchObject({ channelId: REPORT_CHANNEL });
    expect(report.card.version).toBe(report.version);

    const edit = rig.h.edits().at(-1);
    expect(edit?.messageId).toBe(report.card.messageId ?? '');
    expect(fieldValue(edit?.message, 'Evidence')).toBe('copy posted below');
    expect(edit?.message.allowed_mentions).toEqual({ parse: [] });
    expect(eventKinds(rig, report.id)).toContain('delivered');
  });

  test('a redelivered submission event posts nothing twice', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    await rig.deliver(report);

    expect(rig.cardPosts()).toHaveLength(1);
  });

  test('a refused post keeps the report, names the reason and lets the dashboard retry', async () => {
    const rig = reviewRig();
    rig.h.rest.respond(
      `POST /channels/${REPORT_CHANNEL}/messages`,
      discordError(403, 50013, 'Missing Permissions'),
      { times: 1 },
    );

    const report = await rig.file();
    expect(report.card.state).toBe('failed');
    expect(report.card.error).toBeTruthy();
    expect(eventKinds(rig, report.id)).toContain('delivery_failed');

    const outcome = await rig.request('retry_delivery', report.id);
    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toContain(`<#${REPORT_CHANNEL}>`);
    expect(rig.current(report.id).card.state).toBe('posted');
    expect(rig.cardPosts()).toHaveLength(2);
    expect(rig.h.keysUsed()).toContain(
      `moderation:report:${report.id}:card:repost:${rig.answers.at(-1)?.id.split(':')[1]}`,
    );
  });

  test('a rate-limited post stays pending and the patrol posts it after the backoff', async () => {
    const rig = reviewRig();
    rig.h.rest.respond(
      `POST /channels/${REPORT_CHANNEL}/messages`,
      discordError(429, 0, 'You are being rate limited.'),
      { times: 1 },
    );

    const report = await rig.file();
    expect(report.card.state).toBe('pending');

    const ctx = rig.h.context(rig.overrides());
    await runDeliveryPatrol(ctx, rig.deps, rig.h.now());
    expect(rig.current(report.id).card.state).toBe('pending');

    rig.h.advance(cardBackoffMs(1));
    await runDeliveryPatrol(ctx, rig.deps, rig.h.now());

    const delivered = rig.current(report.id);
    expect(delivered.card.state).toBe('posted');
    expect(rig.h.keysUsed()).toContain(`moderation:report:${report.id}:card:2`);
  });

  test('a card still rate-limited on its last attempt is marked failed, so it can be retried', async () => {
    const rig = reviewRig();
    rig.h.rest.respond(
      `POST /channels/${REPORT_CHANNEL}/messages`,
      discordError(429, 0, 'You are being rate limited.'),
    );
    const report = await rig.seed();
    for (let n = 1; n < CARD_ATTEMPTS_MAX; n += 1)
      await rig.store.noteCardAttempt(GUILD, report.id);

    const early = await deliverCard(rig.h.context(rig.overrides()), rig.deps, report, {
      source: 'system',
      now: rig.h.now(),
    });

    expect(early.status).toBe('pending');
    expect(rig.current(report.id).card).toMatchObject({
      state: 'failed',
      attempts: CARD_ATTEMPTS_MAX,
    });
  });

  test('a card edit that loses a race to a claim is redone at the newer version', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    await rig.store.bumpVersion(GUILD, report.id);
    let raced = false;
    rig.h.rest.respond(
      (call) => call.method === 'PATCH' && !raced,
      () => {
        raced = true;
        void rig.store.claim(GUILD, report.id, SECOND_MODERATOR, rig.h.now());
        return { status: 200, body: {} };
      },
    );

    const result = await refreshCard(
      rig.h.context(rig.overrides()),
      rig.deps,
      rig.current(report.id),
      rig.h.now(),
    );

    expect(result).toBe('edited');
    expect(fieldValue(rig.h.edits().at(-1)?.message, 'Status')).toContain(
      `Claimed by <@${SECOND_MODERATOR}>`,
    );
    const settled = rig.current(report.id);
    expect(settled.card.version).toBe(settled.version);
    expect(rig.drafts.locks.size).toBe(0);
  });

  test('while another worker holds the card lock a refresh leaves the edit to it', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    await rig.store.bumpVersion(GUILD, report.id);
    const key = cardLockKey(GUILD, report.id);
    await rig.drafts.lock(key, 'another-worker', CARD_LOCK_TTL_MS);
    const ctx = rig.h.context(rig.overrides());
    const edits = rig.h.edits().length;

    expect(await refreshCard(ctx, rig.deps, rig.current(report.id), rig.h.now())).toBe('skipped');
    expect(rig.h.edits()).toHaveLength(edits);

    await rig.drafts.unlock(key, 'another-worker');
    expect(await refreshCard(ctx, rig.deps, rig.current(report.id), rig.h.now())).toBe('edited');
    expect(rig.drafts.locks.size).toBe(0);
  });

  test('with no report channel the card fails with the setting named', async () => {
    const rig = reviewRig({ reports: { channelId: undefined } });
    const report = await rig.seed();
    await rig.deliver(report);

    const current = rig.current(report.id);
    expect(current.card.state).toBe('failed');
    expect(current.card.error).toContain('No report channel is set');
  });

  test('a deleted card is marked missing and can be reposted without pinging again', async () => {
    const rig = reviewRig({ reports: { notifyRoleIds: [LOW_ROLE] } });
    const report = await rig.file();
    const messageId = report.card.messageId ?? '';

    const missing = await handleCardDeleted(
      rig.store,
      GUILD,
      REPORT_CHANNEL,
      messageId,
      rig.h.now(),
    );
    expect(missing?.card.state).toBe('missing');
    expect(eventKinds(rig, report.id)).toContain('card_missing');

    expect(
      await handleCardDeleted(rig.store, GUILD, REPORT_CHANNEL, messageId, rig.h.now()),
    ).toBeNull();

    const outcome = await rig.request('repost', report.id);
    expect(outcome?.ok).toBe(true);

    const reposted = rig.cardPosts().at(-1);
    expect(reposted?.content).toBeUndefined();
    expect(reposted?.allowed_mentions).toEqual({ parse: [] });
    expect(rig.current(report.id).card.state).toBe('posted');
    expect(rig.current(report.id).card.messageId).not.toBe(messageId);
    expect(eventKinds(rig, report.id)).toContain('reposted');

    const already = await rig.request('repost', report.id);
    expect(already?.ok).toBe(false);
    expect(already?.code).toBe('already_posted');
  });
});

describe('claiming', () => {
  test('Claim defers on the card, claims it and re-renders the card with Unclaim', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const edits = rig.h.edits().length;

    await rig.press('rclaim', report);

    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_DEFERRED_UPDATE);
    expect(rig.h.followUps()).toHaveLength(0);

    const claimed = rig.current(report.id);
    expect(claimed.status).toBe('in_review');
    expect(claimed.assigneeId).toBe(MODERATOR);
    expect(eventKinds(rig, report.id)).toContain('claimed');

    const edit = rig.h.edits().at(-1);
    expect(rig.h.edits()).toHaveLength(edits + 1);
    expect(actionsOf(edit?.message ?? {})[0]).toBe('runclaim');
    expect(fieldValue(edit?.message, 'Status')).toBe(`In review · Claimed by <@${MODERATOR}>`);
  });

  test('the loser of a claim race is told who has it', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    await rig.press('rclaim', report);
    await rig.press('rclaim', report, { userId: SECOND_MODERATOR });

    const answer = lastFollowUp(rig);
    expect(rig.h.statusOf(answer)).toBe('error');
    expect(textOf(answer)).toContain(`Already claimed by <@${MODERATOR}>.`);
    expect(answer.flags).toBe(64);
    expect(rig.current(report.id).assigneeId).toBe(MODERATOR);
  });

  test('only the claimer or someone with Manage Server may unclaim', async () => {
    const rig = reviewRig({ reports: { reviewerRoleIds: [REVIEWER_ROLE] } });
    const report = await rig.file();
    await rig.press('rclaim', report);

    await rig.press('runclaim', report, {
      userId: SECOND_MODERATOR,
      roleIds: [REVIEWER_ROLE],
      permissions: 0n,
    });
    expect(textOf(lastFollowUp(rig))).toContain(
      `Only <@${MODERATOR}> or someone with Manage Server can unclaim this report.`,
    );
    expect(rig.current(report.id).status).toBe('in_review');

    await rig.press('runclaim', report, { userId: SECOND_MODERATOR });
    const open = rig.current(report.id);
    expect(open.status).toBe('open');
    expect(open.assigneeId).toBeNull();
    expect(eventKinds(rig, report.id)).toContain('unclaimed');
  });

  test('members without a reviewer role or Manage Server are refused', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    await rig.press('rclaim', report, { userId: SECOND_MODERATOR, permissions: 0n });

    expect(textOf(lastFollowUp(rig))).toContain('Reviewing reports needs Manage Server');
    expect(rig.current(report.id).status).toBe('open');
  });
});

describe('self-review', () => {
  test('the reported member cannot even look at the report about them', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    await rig.press('rmember', report, { userId: MEMBER });

    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    expect(textOf(lastFollowUp(rig))).toContain('You can’t review a report about yourself.');
  });

  test('the reporter may claim but not decide their own report, unless they own the server', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    await rig.press('raccept', report, { userId: REPORTER });
    expect(textOf(lastFollowUp(rig))).toContain(
      'someone else on staff has to accept or dismiss it',
    );

    await rig.press('rdismiss', report, { userId: REPORTER });
    expect(rig.h.modalsOpened()).toHaveLength(0);

    const byOwner = await rig.seed({ reporterId: OWNER });
    await rig.deliver(byOwner);
    await rig.press('rdismiss', byOwner, { userId: OWNER, permissions: 0n });
    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_MODAL);
  });
});

describe('accepting', () => {
  test('two simultaneous accepts punish once and the loser is told', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const ctx = rig.h.context(rig.overrides());

    const [first, second] = await Promise.all([
      acceptReport(ctx, rig.deps, {
        reportId: report.id,
        actor: actor(),
        punishment: 'ban',
        deleteMessage: false,
        token: 'token-a',
      }),
      acceptReport(ctx, rig.deps, {
        reportId: report.id,
        actor: actor({ id: SECOND_MODERATOR }),
        punishment: 'kick',
        deleteMessage: false,
        token: 'token-b',
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toBe(deciding('ban'));
    expect(second.message).toBe(
      'This report is already being accepted with a ban. Try again in 2 minutes.',
    );

    expect(rig.h.cases().filter((entry) => ['ban', 'kick'].includes(entry.kind))).toHaveLength(1);

    const late = await acceptReport(ctx, rig.deps, {
      reportId: report.id,
      actor: actor({ id: SECOND_MODERATOR }),
      punishment: 'kick',
      deleteMessage: false,
      token: 'token-c',
    });
    expect(late.ok).toBe(false);
    expect(late.message).toBe(`Report \`${report.id}\` was already accepted by <@${MODERATOR}>.`);
  });

  test('an accept resolves the report, links the case, updates the card and tells the reporter', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const ctx = rig.h.context(rig.overrides());

    const result = await acceptReport(ctx, rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'ban',
      reason: 'Scam links',
      deleteMessage: false,
      note: 'second time this week',
      token: 'token-a',
    });

    expect(result.ok).toBe(true);
    const accepted = rig.current(report.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.actionKind).toBe('ban');
    expect(accepted.caseIds).toHaveLength(1);
    expect(result.ok && result.caseId).toBe(accepted.caseIds[0] ?? '');
    expect(accepted.resolutionNote).toBe('second time this week');
    expect(rig.h.keysUsed()).toContain(`moderation:report:${report.id}:accept:action`);

    const edit = rig.h.edits().at(-1);
    expect(actionsOf(edit?.message ?? {})).toEqual(['rmember', 'revidence']);
    expect(fieldValue(edit?.message, 'Status')).toContain(`Accepted by <@${MODERATOR}> · Ban`);

    const dm = rig.h.dms().find((entry) => entry.userId === REPORTER);
    expect(JSON.stringify(dm?.message)).toContain('Your report was accepted');
    expect(accepted.notifications.accepted?.outcome).toBe('sent');

    expect(rig.h.published.map((entry) => entry.type)).toContain('moderation.report_resolved');
    expect(eventKinds(rig, report.id)).toEqual(
      expect.arrayContaining(['action_executed', 'accepted', 'notified']),
    );
  });

  test('a failed punishment keeps the report open, records why, and a retry goes through', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const ctx = rig.h.context(rig.overrides());
    rig.h.rest.respond(
      /PUT \/guilds\/\d+\/bans\//,
      discordError(403, 50013, 'Missing Permissions'),
      {
        times: 1,
      },
    );

    const failed = await acceptReport(ctx, rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'ban',
      deleteMessage: false,
      token: 'token-a',
    });

    expect(failed.ok).toBe(false);
    expect(failed.message).toContain(STILL_OPEN);
    const open = rig.current(report.id);
    expect(open.status).toBe('open');
    expect(open.decision.token).toBeNull();

    const recorded = [...rig.store.events.values()].find((event) => event.kind === 'action_failed');
    expect(recorded?.data).toMatchObject({ kind: 'ban', code: 'discord_403' });

    const retried = await acceptReport(ctx, rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'ban',
      deleteMessage: false,
      token: 'token-b',
    });
    expect(retried.ok).toBe(true);
    expect(rig.current(report.id).status).toBe('accepted');
  });

  test('a rate-limited punishment says so and changes nothing', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    rig.h.rest.respond(/PUT \/guilds\/\d+\/bans\//, discordError(429, 0, 'rate limited'), {
      times: 1,
    });

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'ban',
      deleteMessage: false,
      token: 'token-a',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(RATE_LIMITED);
    expect(rig.current(report.id).status).toBe('open');
  });

  test('a replayed confirmation re-runs the tail without punishing twice', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const ctx = rig.h.context(rig.overrides());
    const request = {
      reportId: report.id,
      actor: actor(),
      punishment: 'warn' as const,
      deleteMessage: false,
      token: 'token-a',
    };

    await acceptReport(ctx, rig.deps, request);
    const again = await acceptReport(ctx, rig.deps, request);

    expect(again.ok).toBe(true);
    expect(rig.h.cases().filter((entry) => entry.kind === 'warn')).toHaveLength(1);
  });

  test('a punishment still being carried out says what to do, without blaming another moderator', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const ctx = rig.h.context(rig.overrides());
    await ctx.executor.execute({
      guildId: GUILD,
      moduleId: 'moderation',
      kind: 'delete_message',
      actorId: MODERATOR,
      idempotencyKey: `${acceptRoot(report.id)}:action`,
      dryRun: false,
      record: false,
      payload: { channelId: CHANNEL, messageId: MESSAGE },
    });

    const request = {
      reportId: report.id,
      actor: actor(),
      punishment: 'ban' as const,
      deleteMessage: false,
    };
    const first = await acceptReport(ctx, rig.deps, { ...request, token: 'token-a' });
    expect(first.ok).toBe(false);
    expect(first.message).toBe(stillSettling(report.id, 'ban', MEMBER));
    expect(first.message).toContain(`If <@${MEMBER}> hasn’t been banned by then`);

    const second = await acceptReport(ctx, rig.deps, { ...request, token: 'token-b' });
    expect(second.message).toBe(deciding('ban'));
    expect(second.message).not.toContain('Another moderator');
  });

  test('the reported message is kept on the case even with message history off', async () => {
    const rig = reviewRig();
    const caseMessages = new MemoryCaseMessageStore(() => rig.h.now());
    rig.deps.caseMessages = caseMessages;
    const report = await rig.file();

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'warn',
      deleteMessage: false,
      token: 'token-a',
    });

    expect(result.ok && result.caseId).toBeTruthy();
    expect(caseMessages.rows).toEqual([
      expect.objectContaining({
        caseId: result.ok ? result.caseId : '',
        messageId: MESSAGE,
        proof: true,
        content: 'free nitro at scam.example',
      }),
    ]);
    expect(rig.h.deletes().filter((ref) => ref.channelId === CHANNEL)).toEqual([]);
  });

  test('retrying a failed ban sends the member a fresh notice after the correction', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const base = rig.overrides();
    const ctx = rig.h.context({
      ...base,
      configInput: { ...reportsInput(), punish: { notifications: { onPunish: true } } },
    });
    rig.h.rest.respond(/PUT \/guilds\/\d+\/bans\//, discordError(500, 0, 'boom'), { times: 1 });

    const request = {
      reportId: report.id,
      actor: actor(),
      punishment: 'ban' as const,
      deleteMessage: false,
    };
    const failed = await acceptReport(ctx, rig.deps, { ...request, token: 'token-a' });
    expect(failed.ok).toBe(false);

    const retried = await acceptReport(ctx, rig.deps, { ...request, token: 'token-b' });
    expect(retried.ok).toBe(true);
    expect(retried.message).toContain('They were told by DM.');

    const notices = rig.h
      .dms()
      .filter((dm) => dm.userId === MEMBER && dm.status < 400)
      .map((dm) => JSON.stringify(dm.message));
    expect(notices).toHaveLength(3);
    expect(notices[1]).toContain("didn't go through");
    expect(notices[2]).not.toContain("didn't go through");
    expect(rig.h.keysUsed()).toContain(`${acceptRoot(report.id)}:token-b:dm:send`);
  });

  test('Accept on the card opens the punish picker as a new ephemeral message', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    await rig.press('raccept', report);

    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    const picker = lastFollowUp(rig);
    expect(picker.flags).toBe(64);
    expect(picker.content).toContain(`Accepting report \`${report.id}\``);
    expect(new Set(actionsOf(picker))).toEqual(new Set(['ppick']));
  });
});

describe('accepting without a punishment', () => {
  function canDelete(rig: ReviewRig): void {
    rig.state.roles.set(MOD_ROLE, {
      id: MOD_ROLE,
      permissions: Permissions.ManageMessages,
      position: 4,
    });
  }

  test('can delete the reported message and records it on the timeline', async () => {
    const rig = reviewRig();
    canDelete(rig);
    const report = await rig.file();

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: true,
      token: 'token-a',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain(
      `Accepted report \`${report.id}\` without a punishment and deleted the reported message.`,
    );
    expect(rig.h.deletes()).toContainEqual({ channelId: CHANNEL, messageId: MESSAGE });
    expect(rig.h.keysUsed()).toContain(`${acceptRoot(report.id)}:none:proof`);

    const accepted = rig.current(report.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.actionKind).toBeNull();
    const deleted = rig.store.events.get(`${report.id}:action_executed:delete_message`);
    expect(deleted?.data).toEqual({ kind: 'delete_message' });
  });

  test('a message that is already gone still accepts the report', async () => {
    const rig = reviewRig();
    canDelete(rig);
    const report = await rig.file();
    rig.h.rest.respond(
      `DELETE /channels/${CHANNEL}/messages/${MESSAGE}`,
      discordError(404, 10008, 'Unknown Message'),
    );

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: true,
      token: 'token-a',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('The reported message was already gone.');
  });

  test('without Manage Messages there it refuses, deletes nothing and leaves the report open', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: true,
      token: 'token-a',
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe('proof_permission');
    expect(result.message).toContain(`You need Manage Messages in <#${CHANNEL}>`);
    expect(result.message).toContain(STILL_OPEN);
    expect(rig.h.deletes().filter((ref) => ref.channelId === CHANNEL)).toEqual([]);

    const open = rig.current(report.id);
    expect(open.status).toBe('open');
    expect(open.decision.token).toBeNull();
    const failed = rig.store.events.get(`${report.id}:action_failed:token-a`);
    expect(failed?.data).toMatchObject({ kind: 'delete_message', code: 'proof_permission' });
  });
});

describe('the note for the reporter', () => {
  test('reaches them with the default accepted and dismissed messages', async () => {
    const rig = reviewRig();
    const ctx = rig.h.context(rig.overrides());

    const first = await rig.file();
    await acceptReport(ctx, rig.deps, {
      reportId: first.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: false,
      reporterNote: 'Thanks — we handled it.',
      token: 'token-a',
    });

    const second = await rig.file({ memberReport: true });
    await dismissReport(ctx, rig.deps, second.id, actor(), {
      reporterNote: 'It was a joke between friends.',
      token: 'token-b',
    });

    const notes = rig.h
      .dms()
      .filter((dm) => dm.userId === REPORTER)
      .map((dm) => dm.message.embeds?.[0]?.fields?.find((f) => f.name === 'Note from staff'));
    expect(notes.map((field) => field?.value)).toEqual([
      'Thanks — we handled it.',
      'It was a joke between friends.',
    ]);
  });
});

describe('permanent bans from the dashboard', () => {
  test('a null duration bans for good even with a default ban length; none uses the default', async () => {
    const rig = reviewRig();
    const withDefault = rig.overrides({
      configInput: { ...reportsInput(), punish: { types: { ban: { defaultDuration: '7d' } } } },
    });
    const requests = createReportRequestListener(rig.deps);
    const accept = (reportId: string, requestId: string, params: Record<string, unknown>) =>
      rig.h.listen(
        moderationEvent('moderation.report_action_requested', {
          requestId,
          auditId: `audit-${requestId}`,
          guildId: GUILD,
          reportId,
          action: 'accept',
          params,
          actorId: MODERATOR,
          actorPermissions: String(REVIEWER_PERMISSIONS),
        }),
        [requests],
        withDefault,
      );

    const permanent = await rig.file();
    await accept(permanent.id, 'request-permanent', { punishment: 'ban', duration: null });
    expect(rig.answers.at(-1)?.outcome.ok).toBe(true);
    expect(rig.h.scheduled).toHaveLength(0);

    const temporary = await rig.file({ targetId: '400000000000000077' });
    await accept(temporary.id, 'request-default', { punishment: 'ban' });
    expect(rig.answers.at(-1)?.outcome.ok).toBe(true);
    expect(rig.h.scheduled).toHaveLength(1);
  });
});

describe('dismissing', () => {
  test('the internal note stays with staff and only the explanation reaches the reporter', async () => {
    const rig = reviewRig({
      reports: {
        notifications: {
          dismissed: {
            enabled: true,
            message: { embeds: [{ description: 'Staff said: {report.explanation}' }] },
          },
        },
      },
    });
    const report = await rig.file();

    await rig.press('rdismiss', report);
    const modal = rig.h.modalsOpened().at(-1) as { custom_id?: string; components?: unknown[] };
    expect(modal.custom_id).toBe(`proton:moderation:rdis:${report.id}`);
    expect(JSON.stringify(modal.components)).toContain('"custom_id":"reporter"');

    const { modalEvent } = await import('./drivers.ts');
    await rig.route(
      modalEvent(
        modal.custom_id ?? '',
        { text: { note: 'internal: repeat offender', reporter: 'We checked the channel.' } },
        { userId: MODERATOR, permissions: REVIEWER_PERMISSIONS, channelId: REPORT_CHANNEL },
      ),
    );

    const answer = lastFollowUp(rig);
    expect(rig.h.statusOf(answer)).toBe('success');
    expect(textOf(answer)).toContain(`Dismissed report \`${report.id}\`.`);

    const dismissed = rig.current(report.id);
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.resolutionNote).toBe('internal: repeat offender');
    expect(dismissed.reporterNote).toBe('We checked the channel.');

    const dm = JSON.stringify(rig.h.dms().find((entry) => entry.userId === REPORTER)?.message);
    expect(dm).toContain('We checked the channel.');
    expect(dm).not.toContain('repeat offender');

    for (const event of rig.store.events.values()) {
      expect(JSON.stringify(event.data)).not.toContain('repeat offender');
      expect(JSON.stringify(event.data)).not.toContain('We checked');
      expect(JSON.stringify(event.data)).not.toContain('Keeps posting');
    }
  });

  test('without dismissed notifications the modal has no reporter field', async () => {
    const rig = reviewRig({
      reports: { notifications: { dismissed: { enabled: false } } },
    });
    const report = await rig.file();

    await rig.press('rdismiss', report);
    const modal = rig.h.modalsOpened().at(-1) as { components?: unknown[] };
    expect(JSON.stringify(modal.components)).not.toContain('"custom_id":"reporter"');
  });
});

describe('stale buttons', () => {
  test('a button for a report that no longer exists says so', async () => {
    const rig = reviewRig();
    await rig.press('rclaim', 'Rgone00');

    expect(textOf(lastFollowUp(rig))).toContain('Report `Rgone00` doesn’t exist');
  });

  test('Accept on a report someone already accepted names who and refreshes the card', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor({ id: SECOND_MODERATOR }),
      punishment: 'none',
      deleteMessage: false,
      token: 'token-a',
    });

    await rig.press('raccept', report);
    expect(textOf(lastFollowUp(rig))).toContain(
      `Report \`${report.id}\` was already accepted by <@${SECOND_MODERATOR}>.`,
    );

    await rig.press('rdismiss', report);
    expect(rig.h.modalsOpened()).toHaveLength(0);
  });

  test('every button answers that moderation is off when it is', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    await rig.route(
      (await import('./drivers.ts')).pressEvent(`proton:moderation:rclaim:${report.id}`, {
        userId: MODERATOR,
        permissions: REVIEWER_PERMISSIONS,
      }),
      { config: { enabled: false } },
    );

    expect(textOf(rig.h.replies().at(-1))).toContain('Moderation is off');
  });
});

describe('viewing', () => {
  test('View evidence hides content from a channel the reviewer cannot read', async () => {
    const rig = reviewRig({ reports: { reviewerRoleIds: [REVIEWER_ROLE] } });
    rig.state.channels.set('500000000000000001', {
      id: '500000000000000001',
      parentId: null,
      overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: Permissions.ViewChannel }],
    });
    const report = await rig.file();

    await rig.press('revidence', report, {
      userId: SECOND_MODERATOR,
      roleIds: [REVIEWER_ROLE],
      permissions: 0n,
    });
    const hidden = JSON.stringify(lastFollowUp(rig));
    expect(hidden).toContain('Message in a channel you can’t view.');
    expect(hidden).not.toContain('free nitro');
    expect(hidden).toContain(
      'Proton needs View Channel and Read Message History in <#500000000000000001>',
    );

    await rig.press('revidence', report, {
      permissions: REVIEWER_PERMISSIONS | Permissions.Administrator,
    });
    expect(JSON.stringify(lastFollowUp(rig))).toContain('free nitro at scam.example');
  });

  test('View member shows facts, cases and report counts in a neutral embed', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    rig.ledger.seed({ caseId: 'Kwarn01', guildId: GUILD, kind: 'warn', targetId: MEMBER });

    await rig.press('rmember', report);

    const answer = lastFollowUp(rig);
    expect(rig.h.statusOf(answer)).toBe('neutral');
    const embed = embedOf(answer);
    expect(embed.title).toBe('Reported member');
    expect(embed.description).toContain(`<@${MEMBER}>`);
    expect(fieldValue(answer, 'Cases')).toBe('1 warning');
    expect(fieldValue(answer, 'Reports')).toContain('1 report by 1 member in 30 days');
  });
});

describe('reporter notifications', () => {
  test('the submitted DM goes out once when it is on and never when it is off', async () => {
    const rig = reviewRig({ reports: { notifications: { submitted: { enabled: true } } } });
    const report = await rig.file();
    await rig.deliver(report);

    const dms = rig.h.dms().filter((dm) => dm.userId === REPORTER);
    expect(dms).toHaveLength(1);
    expect(JSON.stringify(dms[0]?.message)).toContain('Report received');
    expect(JSON.stringify(dms[0]?.message)).toContain(report.id);
    expect(dms[0]?.message.allowed_mentions).toEqual({ parse: [] });

    const current = rig.current(report.id);
    expect(current.notifications.submitted?.outcome).toBe('sent');
    expect(current.dmChannelId).not.toBeNull();

    const quiet = reviewRig();
    await quiet.file();
    expect(quiet.h.dms()).toHaveLength(0);
  });

  test('a reaction report gets the templated DM in place of the fixed one', async () => {
    const rig = reviewRig({
      reports: {
        methods: { reaction: true },
        reaction: { reasonId: 'spam' },
        notifications: { submitted: { enabled: true } },
      },
    });
    rig.putMessage(rawMessage({ authorId: MEMBER, content: 'spam spam spam' }));

    await rig.react(reactionEvent({ userId: REPORTER }));
    for (const event of rig.h.publishedEvents) {
      if (event.type !== 'moderation.report_submitted') continue;
      await rig.h.listen(event, [createReportSubmittedListener(rig.deps)], rig.overrides());
    }

    const dms = rig.h.dms().filter((dm) => dm.userId === REPORTER);
    expect(dms).toHaveLength(1);
    expect(JSON.stringify(dms[0]?.message)).toContain('Report received');
    expect(rig.cardPosts()).toHaveLength(1);
  });

  test('closed DMs are recorded and the moderator is told the reporter was not', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    rig.h.rest.respond(
      `POST /channels/${dmChannelFor(REPORTER)}/messages`,
      discordError(403, 50007, 'Cannot send messages to this user'),
    );

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: false,
      token: 'token-a',
    });

    expect(result.message).toContain('their DMs are closed');
    expect(rig.current(report.id).notifications.accepted?.outcome).toBe('closed');
    expect(eventKinds(rig, report.id)).toContain('notification_failed');
  });

  test('a reporter who shares no server with Proton any more is named as such', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    rig.h.rest.respond(
      `POST /channels/${dmChannelFor(REPORTER)}/messages`,
      discordError(403, 50278, 'Cannot send messages to this user due to having no mutual guilds'),
    );

    const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: false,
      token: 'token-a',
    });

    expect(result.message).toContain('they no longer share a server with Proton');
    expect(rig.current(report.id).notifications.accepted?.outcome).toBe('no_mutual_server');
  });

  test('the patrol finishes a resolution whose card edit failed', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    rig.h.rest.respond(
      `PATCH /channels/${REPORT_CHANNEL}/messages/${report.card.messageId}`,
      discordError(500, 0, 'Internal Server Error'),
      { times: 1 },
    );

    await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'none',
      deleteMessage: false,
      token: 'token-a',
    });
    const stale = rig.current(report.id);
    expect(stale.card.version).toBeLessThan(stale.version);

    await runDeliveryPatrol(rig.h.context(rig.overrides()), rig.deps, rig.h.now());

    const finished = rig.current(report.id);
    expect(finished.card.version).toBe(finished.version);
    expect(fieldValue(rig.h.edits().at(-1)?.message, 'Status')).toContain('Accepted by');
    expect(rig.h.dms().filter((dm) => dm.userId === REPORTER)).toHaveLength(1);
  });
});

describe('interrupted decisions', () => {
  test('a punishment that went through before a crash is finished, never repeated', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const ctx = rig.h.context(rig.overrides());

    rig.ledger.seed({
      caseId: 'Kearly1',
      guildId: GUILD,
      kind: 'ban',
      targetId: MEMBER,
      idempotencyKey: `${acceptRoot(report.id)}:action`,
    });
    await rig.store.beginDecision({
      guildId: GUILD,
      id: report.id,
      token: 'crashed',
      kind: 'ban',
      now: rig.h.now(),
      staleMs: DECISION_STALE_MS,
    });

    const held = await acceptReport(ctx, rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'kick',
      deleteMessage: false,
      token: 'token-b',
    });
    expect(held.message).toBe(deciding('ban'));

    rig.h.advance(DECISION_STALE_MS + 1000);

    const dismissed = await dismissReport(ctx, rig.deps, report.id, actor(), {
      token: 'token-d',
    });
    expect(dismissed.ok).toBe(false);
    expect(dismissed.message).toBe(
      'A ban already went through for this report, so accept it instead.',
    );
    expect(rig.current(report.id).caseIds).toEqual(['Kearly1']);

    const taken = await acceptReport(ctx, rig.deps, {
      reportId: report.id,
      actor: actor(),
      punishment: 'kick',
      deleteMessage: false,
      token: 'token-c',
    });
    expect(taken.ok).toBe(true);
    expect(taken.message).toContain('The earlier ban already went through.');

    const accepted = rig.current(report.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.actionKind).toBe('ban');
    expect(rig.h.cases().filter((entry) => entry.kind === 'kick')).toHaveLength(0);
  });
});

describe('dashboard requests', () => {
  test('success and failure are both answered in the mailbox under guild:request', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    const claimed = await rig.request('claim', report.id, {}, { requestId: 'request-claim-1' });
    expect(claimed).toMatchObject({ ok: true, code: 'ok' });
    expect(rig.answers.at(-1)?.id).toBe(`${GUILD}:request-claim-1`);

    const missing = await rig.request('claim', 'Rnope00', {}, { requestId: 'request-claim-2' });
    expect(missing).toMatchObject({ ok: false, code: 'not_found' });

    const refused = await rig.request(
      'dismiss',
      report.id,
      {},
      { requestId: 'request-dismiss-1', permissions: 0n, id: SECOND_MODERATOR },
    );
    expect(refused).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  test('a request for another server is answered and changes nothing', async () => {
    const rig = reviewRig();
    const report = await rig.file();
    const other = '900000000000000077';

    await rig.h.listen(
      moderationEvent('moderation.report_action_requested', {
        requestId: 'request-other-1',
        auditId: 'audit-1',
        guildId: other,
        reportId: report.id,
        action: 'claim',
        params: {},
        actorId: MODERATOR,
        actorPermissions: String(REVIEWER_PERMISSIONS),
      }),
      [createReportRequestListener(rig.deps)],
      rig.overrides(),
    );

    expect(rig.answers.at(-1)).toMatchObject({
      id: `${other}:request-other-1`,
      outcome: { ok: false, code: 'invalid_request' },
    });
    expect(rig.current(report.id).status).toBe('open');
  });

  test('an accept from the dashboard punishes with the request id as the decision token', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    const outcome = await rig.request(
      'accept',
      report.id,
      { punishment: 'warn', reason: 'Spam', reporterNote: 'Thanks' },
      { requestId: 'request-accept-1' },
    );

    expect(outcome?.ok).toBe(true);
    expect(outcome?.caseId).toBe(rig.current(report.id).caseIds[0] ?? '');
    expect(rig.current(report.id).decision.token).toBe('request-accept-1');

    const replay = await rig.request(
      'accept',
      report.id,
      { punishment: 'warn' },
      { requestId: 'request-accept-1' },
    );
    expect(replay?.ok).toBe(true);
    expect(rig.h.cases().filter((entry) => entry.kind === 'warn')).toHaveLength(1);
  });

  test('assigning is for admins, and an error inside still answers the mailbox', async () => {
    const rig = reviewRig();
    const report = await rig.file();

    const assigned = await rig.request('assign', report.id, { assigneeId: SECOND_MODERATOR });
    expect(assigned?.ok).toBe(true);
    expect(rig.current(report.id).assigneeId).toBe(SECOND_MODERATOR);
    expect(eventKinds(rig, report.id)).toContain('assigned');

    rig.store.get = async () => {
      throw new Error('database went away');
    };
    const broken = await rig.request('claim', report.id, {}, { requestId: 'request-broken-1' });
    expect(broken).toMatchObject({ ok: false, code: 'failed' });
    expect(rig.answers.at(-1)?.id).toBe(`${GUILD}:request-broken-1`);
  });
});
