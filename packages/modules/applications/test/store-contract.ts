import { beforeEach, describe, expect, test } from 'bun:test';
import type { ApplicationLifecycleEvent, ApplicationStatus } from '@proton/core';
import { applicationsConfigSchema } from '../src/config.ts';
import { CARD_KEY, type EffectPlan, planEffects, XP_KEY } from '../src/effects.ts';
import {
  type ApplicationRecord,
  type ApplicationStore,
  CHANGED_ERROR,
  type EffectClaim,
  type EffectRecord,
  type PlanEffects,
  type TransitionInput,
} from '../src/store.ts';
import { snapshotOf } from '../src/version.ts';
import { queueQuerySchema } from '../src/view.ts';

export interface StoreHarness {
  store: ApplicationStore;
  wakes(guildId: string): Promise<number>;
  clearWakes(guildId: string): Promise<void>;
}

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const CHANNEL = '300000000000000001';
const OLD_CHANNEL = '300000000000000002';
const ROLE = '200000000000000001';
const ACCEPT_ROLE = '200000000000000002';
const REVIEWER = '100000000000000001';
const OTHER_REVIEWER = '100000000000000002';
const APPLICANT = '400000000000000001';
const MESSAGE = '500000000000000001';
const OLD_MESSAGE = '500000000000000002';
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0, 123);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEASE = MINUTE;
const PENDING: ApplicationStatus[] = ['submitted', 'in_review', 'needs_info', 'waitlisted'];
const STAFF = { id: REVIEWER, source: 'dashboard' as const };

const config = applicationsConfigSchema.parse({
  reviewChannelId: CHANNEL,
  forms: [
    {
      id: 'mods',
      name: 'Moderator Application',
      sections: [
        {
          id: 'about',
          questions: [{ id: 'why', type: 'paragraph', label: 'Why do you want to help?' }],
        },
      ],
      actions: {
        onSubmit: { addRoleIds: [ROLE] },
        onAccept: { addRoleIds: [ACCEPT_ROLE], xp: 50 },
        onReject: { removeRoleIds: [ACCEPT_ROLE] },
      },
    },
  ],
});

const form = (() => {
  const first = config.forms[0];
  if (first === undefined) throw new Error('the test form did not parse');
  return first;
})();

const ANSWERS = [
  {
    questionId: 'why',
    sectionId: 'about',
    label: 'Why do you want to help?',
    type: 'paragraph' as const,
    value: 'I like helping people',
    display: 'I like helping people',
  },
];

function applicantId(index: number): string {
  return `4000000000000002${String(index).padStart(2, '0')}`;
}

export function describeStoreBookkeeping(open: () => Promise<StoreHarness>): void {
  let harness: StoreHarness;
  let store: ApplicationStore;
  let sequence = 0;

  beforeEach(async () => {
    harness = await open();
    store = harness.store;
  });

  function audit(action: string) {
    sequence += 1;
    return {
      actorId: REVIEWER,
      source: 'dashboard' as const,
      action: `module.applications.${action}`,
      id: `applications.${action}:contract-${sequence}`,
    };
  }

  function planned(event: ApplicationLifecycleEvent | 'card_only', at: number): PlanEffects {
    return (next, revision) =>
      planEffects(event, { config, form, application: next, revision, now: at, actorId: REVIEWER });
  }

  async function draft(applicant: string, guildId: string): Promise<ApplicationRecord> {
    const latest = (await store.latestVersions(guildId)).get(form.id);
    const version =
      latest ??
      (
        await store.publish({
          guildId,
          formId: form.id,
          snapshot: snapshotOf(form),
          draftPolicy: 'keep',
          publishedBy: REVIEWER,
          audit: audit('publish'),
          now: NOW,
        })
      ).version;

    const started = await store.startDraft({
      guildId,
      formId: form.id,
      versionId: version.id,
      applicantId: applicant,
      applicantName: `name ${applicant.slice(-2)}`,
      expiresAt: NOW + 30 * DAY,
      source: 'discord',
      now: NOW,
    });
    return started.application;
  }

  async function submitted(applicant = APPLICANT, guildId = GUILD): Promise<ApplicationRecord> {
    const started = await draft(applicant, guildId);
    const result = await store.submit({
      guildId,
      applicationId: started.id,
      applicantId: applicant,
      expectedRevision: started.revision,
      answers: ANSWERS,
      source: 'discord',
      applicantName: started.applicantName,
      limits: { cooldownDays: 0, maxActive: 5 },
      reviewDueAt: null,
      plan: planned('applications.submitted', NOW),
      lifecycle: {
        guildId,
        applicationId: started.id,
        formId: form.id,
        formName: form.name,
        versionId: started.versionId,
        applicantId: applicant,
        actorId: applicant,
      },
      now: NOW,
    });
    if (result.status !== 'submitted') throw new Error(`expected submitted, got ${result.code}`);
    return result.application;
  }

  async function transition(input: TransitionInput): Promise<ApplicationRecord> {
    const result = await store.transition(input);
    if (result.status !== 'done') throw new Error(`the ${input.action} transition went stale`);
    return result.application;
  }

  function decide(
    application: ApplicationRecord,
    choice: 'accept' | 'reject',
    at: number,
  ): TransitionInput {
    const status = choice === 'accept' ? 'accepted' : 'rejected';
    const lifecycle: ApplicationLifecycleEvent =
      choice === 'accept' ? 'applications.accepted' : 'applications.rejected';

    return {
      guildId: application.guildId,
      applicationId: application.id,
      action: choice,
      actor: { id: REVIEWER, source: 'discord' },
      expect: { statuses: PENDING },
      patch: {
        status,
        decidedAt: at,
        decidedBy: REVIEWER,
        decisionReason: 'Thanks for applying',
        contentPurgeAt: at + 30 * DAY,
      },
      thread: { kind: 'decision', body: 'Thanks for applying' },
      event: { kind: status, lifecycle },
      plan: planned(lifecycle, at),
      now: at,
    };
  }

  function reopen(application: ApplicationRecord, at: number): TransitionInput {
    return {
      guildId: application.guildId,
      applicationId: application.id,
      action: 'reopen',
      actor: STAFF,
      expect: { statuses: ['accepted', 'rejected'], revision: application.revision },
      patch: {
        status: 'submitted',
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        reopenedCount: application.reopenedCount + 1,
        contentPurgeAt: null,
      },
      note: { body: 'A second look' },
      event: { kind: 'reopened', lifecycle: 'applications.reopened' },
      plan: planned('applications.reopened', at),
      clearVotes: true,
      supersede: true,
      now: at,
    };
  }

  function vote(
    application: ApplicationRecord,
    reviewerId: string,
    at: number,
    plan?: PlanEffects,
  ): TransitionInput {
    return {
      guildId: application.guildId,
      applicationId: application.id,
      action: 'vote',
      actor: { id: reviewerId, source: 'discord' },
      expect: { statuses: PENDING },
      patch: {},
      vote: { vote: 'accept', score: null },
      event: { kind: 'voted', data: { vote: 'accept' } },
      ...(plan === undefined ? {} : { plan }),
      now: at,
    };
  }

  function requestInfo(application: ApplicationRecord, dueAt: number): TransitionInput {
    return {
      guildId: application.guildId,
      applicationId: application.id,
      action: 'request_info',
      actor: STAFF,
      expect: { statuses: PENDING },
      patch: { status: 'needs_info', infoRequestedAt: NOW, infoDueAt: dueAt },
      thread: { kind: 'info_request', body: 'Which timezone are you in?' },
      event: { kind: 'information_requested' },
      now: NOW,
    };
  }

  async function effectsOf(application: ApplicationRecord): Promise<EffectRecord[]> {
    return (await store.detail(application.guildId, application.id))?.effects ?? [];
  }

  async function effect(application: ApplicationRecord, key: string): Promise<EffectRecord> {
    const found = (await effectsOf(application)).find((candidate) => candidate.key === key);
    if (found === undefined) throw new Error(`no effect ${key}`);
    return found;
  }

  async function claim(row: EffectRecord, at: number): Promise<EffectClaim> {
    const claimed = await store.claimEffect(row.guildId, row.id, at, LEASE);
    if (claimed === null) throw new Error(`effect ${row.key} could not be claimed`);
    return claimed;
  }

  async function fail(row: EffectRecord, at: number, errorCode = 'refused'): Promise<void> {
    const claimed = await claim(row, at);
    const done = await store.finishEffect(row.guildId, row.id, claimed.token, {
      status: 'failed',
      errorCode,
      error: 'It didn’t work.',
    });
    if (!done) throw new Error(`effect ${row.key} could not be finished`);
  }

  async function succeed(row: EffectRecord, at: number): Promise<void> {
    const claimed = await claim(row, at);
    const done = await store.finishEffect(row.guildId, row.id, claimed.token, {
      status: 'succeeded',
    });
    if (!done) throw new Error(`effect ${row.key} could not be finished`);
  }

  describe('effect bookkeeping', () => {
    test('a claim token is never reused, so a stalled worker can’t finish over a retried claim', async () => {
      const application = await submitted();
      const dm = await effect(application, `submitted:${application.revision}:dm`);

      const stalled = await claim(dm, NOW);
      const takeover = await claim(dm, NOW + LEASE + SECOND);
      expect(
        await store.finishEffect(GUILD, dm.id, takeover.token, {
          status: 'failed',
          errorCode: 'dms_closed',
          error: 'Their DMs are closed.',
        }),
      ).toBe(true);

      const retried = await store.retryEffect(GUILD, application.id, dm.id, STAFF);
      expect(retried).toMatchObject({ status: 'pending', attempts: 0, claimSeq: 2 });

      const current = await claim(dm, (await store.now()) + SECOND);
      expect([stalled.token, takeover.token, current.token]).toEqual([1, 2, 3]);
      expect(current.effect.attempts).toBe(1);

      expect(await store.finishEffect(GUILD, dm.id, stalled.token, { status: 'succeeded' })).toBe(
        false,
      );
      expect(await store.finishEffect(GUILD, dm.id, takeover.token, { status: 'succeeded' })).toBe(
        false,
      );
      expect(
        await store.finishEffect(GUILD, dm.id, current.token, {
          status: 'failed',
          errorCode: 'dms_closed',
          error: 'Their DMs are closed.',
        }),
      ).toBe(true);
      expect(await effect(application, dm.key)).toMatchObject({
        status: 'failed',
        attempts: 1,
        claimSeq: 3,
      });
    });

    test('a re-queue while the card is out keeps its lease, fences the holder and starts a new count', async () => {
      const application = await submitted();
      const card = await effect(application, CARD_KEY);

      const holder = await claim(card, NOW);
      expect(holder.token).toBe(1);

      await transition(vote(application, REVIEWER, NOW + SECOND, planned('card_only', NOW)));
      expect(await effect(application, CARD_KEY)).toMatchObject({
        status: 'pending',
        attempts: 0,
        claimSeq: 1,
        leaseUntil: NOW + LEASE,
        revision: application.revision + 1,
      });

      expect(await store.finishEffect(GUILD, card.id, holder.token, { status: 'succeeded' })).toBe(
        false,
      );
      expect(await store.claimEffect(GUILD, card.id, NOW + 2 * SECOND, LEASE)).toBeNull();

      const next = await claim(card, NOW + LEASE + SECOND);
      expect(next).toMatchObject({ token: 2, effect: { attempts: 1 } });
      expect(await store.finishEffect(GUILD, card.id, next.token, { status: 'succeeded' })).toBe(
        true,
      );
    });

    test('the card renders any number of times, and the purge re-render still runs', async () => {
      const application = await submitted();
      const tokens: number[] = [];

      for (let render = 1; render <= 7; render += 1) {
        const at = NOW + render * SECOND;
        const card = await effect(application, CARD_KEY);
        expect(card).toMatchObject({ status: 'pending', attempts: 0 });

        const claimed = await claim(card, at);
        expect(claimed.effect.attempts).toBe(1);
        tokens.push(claimed.token);
        expect(
          await store.finishEffect(GUILD, card.id, claimed.token, { status: 'succeeded' }),
        ).toBe(true);

        await transition(vote(application, REVIEWER, at, planned('card_only', at)));
      }
      expect(tokens).toEqual([1, 2, 3, 4, 5, 6, 7]);

      const current = await store.get(GUILD, application.id);
      if (current === null) throw new Error('the application vanished');
      const accepted = await transition(decide(current, 'accept', NOW + MINUTE));
      await succeed(await effect(application, CARD_KEY), NOW + MINUTE);
      expect(
        await store.rememberCard(GUILD, application.id, CHANNEL, MESSAGE, accepted.revision),
      ).toBe(true);

      expect(await store.purgeContent(NOW + MINUTE + 31 * DAY, 100)).toBe(1);
      const purge = await effect(application, CARD_KEY);
      expect(purge).toMatchObject({ status: 'pending', trigger: 'purge', attempts: 0 });

      const claimed = await claim(purge, NOW + MINUTE + 31 * DAY);
      expect(claimed).toMatchObject({ token: 9, effect: { attempts: 1 } });
      expect(
        await store.finishEffect(GUILD, purge.id, claimed.token, { status: 'succeeded' }),
      ).toBe(true);
    });

    test('a card posted after its application was deleted isn’t remembered', async () => {
      const live = await submitted(applicantId(1));
      expect(await store.rememberCard(GUILD, live.id, CHANNEL, MESSAGE, live.revision)).toBe(true);
      expect(await store.get(GUILD, live.id)).toMatchObject({
        cardChannelId: CHANNEL,
        cardMessageId: MESSAGE,
      });

      const deleted = await submitted(applicantId(2));
      await store.deleteApplication({
        guildId: GUILD,
        applicationId: deleted.id,
        actor: STAFF,
        audit: audit('delete'),
        now: NOW + MINUTE,
      });

      expect(
        await store.rememberCard(GUILD, deleted.id, CHANNEL, OLD_MESSAGE, deleted.revision),
      ).toBe(false);
      expect(await store.get(GUILD, deleted.id)).toMatchObject({
        cardChannelId: null,
        cardMessageId: null,
      });
      expect(await store.rememberCard(OTHER_GUILD, live.id, CHANNEL, OLD_MESSAGE, 9)).toBe(false);
      expect((await store.get(GUILD, live.id))?.cardMessageId).toBe(MESSAGE);
    });

    test('cancelling an action redraws a posted card, but cancelling the card doesn’t re-queue it', async () => {
      const application = await submitted();
      await succeed(await effect(application, CARD_KEY), NOW);
      await store.rememberCard(GUILD, application.id, CHANNEL, MESSAGE, application.revision);

      const dm = await effect(application, `submitted:${application.revision}:dm`);
      await fail(dm, NOW);
      await harness.clearWakes(GUILD);

      expect(await store.cancelEffect(GUILD, application.id, dm.id, STAFF)).toMatchObject({
        status: 'cancelled',
      });
      expect(await effect(application, CARD_KEY)).toMatchObject({
        status: 'pending',
        trigger: 'card',
        attempts: 0,
        params: { channelId: CHANNEL },
      });
      expect(await harness.wakes(GUILD)).toBeGreaterThan(0);

      const card = await effect(application, CARD_KEY);
      await fail(card, (await store.now()) + SECOND, 'missing_access');
      expect(await store.cancelEffect(GUILD, application.id, card.id, STAFF)).toMatchObject({
        status: 'cancelled',
      });
      expect((await effect(application, CARD_KEY)).status).toBe('cancelled');

      const unposted = await submitted(applicantId(3));
      const unpostedDm = await effect(unposted, `submitted:${unposted.revision}:dm`);
      await store.cancelEffect(GUILD, unposted.id, unpostedDm.id, STAFF);
      expect(await effect(unposted, CARD_KEY)).toMatchObject({
        status: 'pending',
        trigger: 'submitted',
      });
    });

    test('an old card is tracked for removal once, and a deletion leaves that removal queued', async () => {
      const application = await submitted();
      await store.rememberCard(GUILD, application.id, CHANNEL, MESSAGE, application.revision);
      await harness.clearWakes(GUILD);

      await store.queueCardRemoval(GUILD, application.id, OLD_CHANNEL, OLD_MESSAGE);
      await store.queueCardRemoval(GUILD, application.id, OLD_CHANNEL, OLD_MESSAGE);
      await store.queueCardRemoval(GUILD, 'no-such-application', OLD_CHANNEL, OLD_MESSAGE);
      await store.queueCardRemoval(OTHER_GUILD, application.id, OLD_CHANNEL, OLD_MESSAGE);

      const removals = (await effectsOf(application)).filter((row) => row.kind === 'delete_card');
      expect(removals).toHaveLength(1);
      expect(removals[0]).toMatchObject({
        key: `delete_card:${OLD_MESSAGE}`,
        status: 'pending',
        params: { channelId: OLD_CHANNEL, messageId: OLD_MESSAGE },
      });
      expect(await harness.wakes(GUILD)).toBeGreaterThan(0);

      await store.deleteApplication({
        guildId: GUILD,
        applicationId: application.id,
        actor: STAFF,
        audit: audit('delete'),
        now: NOW + MINUTE,
      });

      const after = await effectsOf(application);
      expect(
        after
          .filter((row) => row.kind === 'delete_card')
          .map((row) => [row.key, row.status, row.params.messageId])
          .sort(),
      ).toEqual([
        ['delete_card', 'pending', MESSAGE],
        [`delete_card:${OLD_MESSAGE}`, 'pending', OLD_MESSAGE],
      ]);
      expect(
        after
          .filter((row) => row.kind !== 'delete_card')
          .every((row) => row.status === 'cancelled'),
      ).toBe(true);
    });
  });

  describe('reopening', () => {
    test('clears the round’s votes and skips the earlier decision’s leftover actions', async () => {
      const application = await submitted();
      const voted = await transition(vote(application, OTHER_REVIEWER, NOW));
      const noted = await transition({
        guildId: GUILD,
        applicationId: application.id,
        action: 'note',
        actor: STAFF,
        expect: {},
        patch: {},
        note: { body: 'Looks keen' },
        event: { kind: 'note' },
        bumpRevision: false,
        now: NOW,
      });
      expect(noted.revision).toBe(voted.revision);
      expect(await store.votes(GUILD, application.id)).toHaveLength(1);

      const accepted = await transition(decide(voted, 'accept', NOW + MINUTE));
      const round = accepted.revision;

      await fail(await effect(application, `accepted:${round}:dm`), NOW + MINUTE, 'dms_closed');
      await claim(
        await effect(application, `accepted:${round}:add_role:${ACCEPT_ROLE}`),
        NOW + MINUTE,
      );
      await claim(await effect(application, `accepted:${round}:cleanup`), NOW + 3 * MINUTE);

      const before = await store.list(GUILD, {
        ...queueQuerySchema.parse({ view: 'all' }),
        formIds: [form.id],
        viewerId: REVIEWER,
      });
      expect(before.problems.get(application.id)?.map((row) => row.key)).toEqual([
        `accepted:${round}:dm`,
      ]);

      await transition(reopen(accepted, NOW + 3 * MINUTE + 30 * SECOND));

      expect(await store.votes(GUILD, application.id)).toEqual([]);
      const skipped = { status: 'skipped', errorCode: 'changed', error: CHANGED_ERROR };
      expect(await effect(application, `accepted:${round}:dm`)).toMatchObject(skipped);
      expect(await effect(application, `accepted:${round}:add_role:${ACCEPT_ROLE}`)).toMatchObject({
        ...skipped,
        leaseUntil: null,
      });
      expect(await effect(application, `accepted:${round}:cleanup`)).toMatchObject({
        status: 'running',
        leaseUntil: NOW + 4 * MINUTE,
      });
      expect(await effect(application, XP_KEY)).toMatchObject({ status: 'pending' });
      expect(
        await effect(application, `submitted:${application.revision}:add_role:${ROLE}`),
      ).toMatchObject({ status: 'pending' });

      const after = await store.list(GUILD, {
        ...queueQuerySchema.parse({ view: 'all' }),
        formIds: [form.id],
        viewerId: REVIEWER,
      });
      expect(after.problems.get(application.id)).toBeUndefined();
    });

    test('accepting again re-queues an XP reward that never landed, never one that did', async () => {
      const application = await submitted();
      const first = await transition(decide(application, 'accept', NOW + MINUTE));
      const xp = await effect(application, XP_KEY);
      await fail(xp, NOW + MINUTE, 'leveling_off');

      const reopened = await transition(reopen(first, NOW + 2 * MINUTE));
      expect(await effect(application, XP_KEY)).toMatchObject({
        status: 'failed',
        errorCode: 'leveling_off',
      });

      const second = await store.transition(decide(reopened, 'accept', NOW + 3 * MINUTE));
      if (second.status !== 'done') throw new Error('the second accept went stale');
      expect(second.effects.map((row) => row.key)).toContain(XP_KEY);
      expect(await effect(application, XP_KEY)).toMatchObject({
        id: xp.id,
        status: 'pending',
        attempts: 0,
        claimSeq: 1,
        revision: second.application.revision,
        trigger: 'accepted',
        params: { amount: 50, userId: APPLICANT },
        result: {},
        errorCode: null,
        error: null,
        leaseUntil: null,
      });

      const granted = await claim(await effect(application, XP_KEY), NOW + 3 * MINUTE);
      expect(granted.token).toBe(2);
      await store.finishEffect(GUILD, xp.id, granted.token, {
        status: 'succeeded',
        result: { granted: true },
      });

      const again = await transition(reopen(second.application, NOW + 4 * MINUTE));
      const third = await store.transition(decide(again, 'accept', NOW + 5 * MINUTE));
      if (third.status !== 'done') throw new Error('the third accept went stale');
      expect(third.effects.map((row) => row.key)).not.toContain(XP_KEY);
      expect(await effect(application, XP_KEY)).toMatchObject({
        status: 'succeeded',
        revision: second.application.revision,
        result: { granted: true },
      });
    });
  });

  describe('schedules after a settings change', () => {
    test('lapsed follow-up deadlines move forward and later ones stay', async () => {
      const soon = await transition(requestInfo(await submitted(applicantId(1)), NOW + HOUR));
      const later = await transition(requestInfo(await submitted(applicantId(2)), NOW + 3 * DAY));
      const waiting = await submitted(applicantId(3));
      const elsewhere = await transition(
        requestInfo(await submitted(applicantId(4), OTHER_GUILD), NOW + HOUR),
      );

      expect(await store.extendInfoDeadlines(GUILD, NOW + DAY)).toBe(1);

      expect(await store.get(GUILD, soon.id)).toMatchObject({
        infoDueAt: NOW + DAY,
        revision: soon.revision,
        status: 'needs_info',
      });
      expect((await store.get(GUILD, later.id))?.infoDueAt).toBe(NOW + 3 * DAY);
      expect((await store.get(GUILD, waiting.id))?.infoDueAt).toBeNull();
      expect((await store.get(OTHER_GUILD, elsewhere.id))?.infoDueAt).toBe(NOW + HOUR);
      expect((await store.dueWork(GUILD, NOW + 2 * HOUR, 50)).infoExpiries).toEqual([]);
      expect(await store.extendInfoDeadlines(GUILD, NOW + DAY)).toBe(0);
    });

    test('a new keep-for period reschedules every decided application that still has its answers', async () => {
      const accepted = await transition(
        decide(await submitted(applicantId(1)), 'accept', NOW + MINUTE),
      );
      const withdrawn = await transition({
        guildId: GUILD,
        applicationId: (await submitted(applicantId(2))).id,
        action: 'withdraw',
        actor: { id: applicantId(2), source: 'discord' },
        expect: { statuses: PENDING },
        patch: {
          status: 'withdrawn',
          withdrawnAt: NOW + 2 * MINUTE,
          contentPurgeAt: NOW + 30 * DAY,
        },
        event: { kind: 'withdrawn' },
        now: NOW + 2 * MINUTE,
      });
      const waiting = await submitted(applicantId(3));
      const purged = await transition({
        ...decide(await submitted(applicantId(4)), 'reject', NOW),
        patch: {
          status: 'rejected',
          decidedAt: NOW,
          decidedBy: REVIEWER,
          contentPurgeAt: NOW + HOUR,
        },
      });
      expect(await store.purgeContent(NOW + 2 * HOUR, 100)).toBe(1);
      const elsewhere = await transition(
        decide(await submitted(applicantId(5), OTHER_GUILD), 'accept', NOW + MINUTE),
      );

      expect(await store.rescheduleRetention(GUILD, 7)).toBe(2);

      expect((await store.get(GUILD, accepted.id))?.contentPurgeAt).toBe(NOW + MINUTE + 7 * DAY);
      expect((await store.get(GUILD, withdrawn.id))?.contentPurgeAt).toBe(
        NOW + 2 * MINUTE + 7 * DAY,
      );
      expect((await store.get(GUILD, waiting.id))?.contentPurgeAt).toBeNull();
      expect((await store.get(GUILD, purged.id))?.contentPurgeAt).toBe(NOW + HOUR);
      expect((await store.get(OTHER_GUILD, elsewhere.id))?.contentPurgeAt).toBe(
        NOW + MINUTE + 30 * DAY,
      );

      expect(await store.purgeContent(NOW + 8 * DAY, 100)).toBe(2);
    });
  });

  describe('deleting', () => {
    test('plans the caller’s role cleanup and keeps an unfinished one', async () => {
      const pending = await submitted(applicantId(1));
      const seen: Array<{ deletedAt: number | null; revision: number; given: number }> = [];
      const cleanup: PlanEffects = (application, revision): EffectPlan[] => {
        seen.push({
          deletedAt: application.deletedAt,
          revision: application.revision,
          given: revision,
        });
        return [
          {
            key: `delete:${revision}:cleanup`,
            kind: 'remove_role',
            trigger: 'delete',
            params: { fromGrants: true, roleIds: [ROLE], userId: application.applicantId },
          },
        ];
      };

      const deleted = await store.deleteApplication({
        guildId: GUILD,
        applicationId: pending.id,
        actor: STAFF,
        audit: audit('delete'),
        cleanup,
        now: NOW + MINUTE,
      });
      if (deleted.status !== 'deleted') throw new Error('the application was not deleted');
      const revision = deleted.application.revision;
      expect(seen).toEqual([{ deletedAt: NOW + MINUTE, revision, given: revision }]);

      const effects = await effectsOf(pending);
      expect(effects.find((row) => row.key === `delete:${revision}:cleanup`)).toMatchObject({
        status: 'pending',
        kind: 'remove_role',
        params: { fromGrants: true, roleIds: [ROLE] },
      });
      expect(
        effects
          .filter((row) => row.key !== `delete:${revision}:cleanup`)
          .every((row) => row.status === 'cancelled'),
      ).toBe(true);

      const rejected = await transition(
        decide(await submitted(applicantId(2)), 'reject', NOW + MINUTE),
      );
      await store.deleteApplication({
        guildId: GUILD,
        applicationId: rejected.id,
        actor: STAFF,
        audit: audit('delete'),
        now: NOW + 2 * MINUTE,
      });
      expect(await effect(rejected, `rejected:${rejected.revision}:cleanup`)).toMatchObject({
        status: 'pending',
      });
      expect(await effect(rejected, `rejected:${rejected.revision}:dm`)).toMatchObject({
        status: 'cancelled',
      });
      expect(
        await effect(rejected, `rejected:${rejected.revision}:remove_role:${ACCEPT_ROLE}`),
      ).toMatchObject({ status: 'cancelled' });
    });

    test('deleting an applicant plans cleanup for each sent application and none for a draft', async () => {
      const sent = await submitted(applicantId(1));
      const drafted = await draft(applicantId(1), GUILD);
      expect(drafted.status).toBe('draft');
      const asked: string[] = [];

      expect(
        await store.deleteApplicant({
          guildId: GUILD,
          applicantId: applicantId(1),
          actor: STAFF,
          audit: audit('delete_applicant'),
          cleanup: (application, revision) => {
            asked.push(application.id);
            return [
              {
                key: `delete:${revision}:cleanup`,
                kind: 'remove_role',
                trigger: 'delete',
                params: { fromGrants: true, roleIds: [ROLE], userId: application.applicantId },
              },
            ];
          },
          now: NOW + MINUTE,
        }),
      ).toEqual({ deleted: 2 });

      expect(asked).toEqual([sent.id]);
      expect(
        (await effectsOf(sent)).filter(
          (row) => row.kind === 'remove_role' && row.status === 'pending',
        ),
      ).toHaveLength(1);
      expect(await store.get(GUILD, drafted.id)).toBeNull();
    });
  });
}
