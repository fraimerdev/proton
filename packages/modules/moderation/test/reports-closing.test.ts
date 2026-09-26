import { describe, expect, test } from 'bun:test';
import type { RestRequestOptions } from '@proton/core';
import { handleCardDeleted, REPORT_CLOSE_JOB, runDeliveryPatrol } from '../src/reports/delivery.ts';
import { acceptReport, dismissReport } from '../src/reports/review.ts';
import { closeBackoffMs } from '../src/reports/store.ts';
import { discordError, MOD_ROLE } from './harness.ts';
import {
  ARCHIVE_CHANNEL,
  GUILD,
  MODERATOR,
  REPORT_CHANNEL,
  REVIEWER_PERMISSIONS,
  type ReviewRig,
  reviewRig,
} from './reports-review-setup.ts';

const actor = {
  id: MODERATOR,
  roleIds: [MOD_ROLE],
  permissions: REVIEWER_PERMISSIONS,
  source: 'discord' as const,
};

function withArchive(rig: ReviewRig): void {
  rig.state.channels.set(ARCHIVE_CHANNEL, { id: ARCHIVE_CHANNEL, parentId: null, overwrites: [] });
}

async function accepted(rig: ReviewRig) {
  const report = await rig.file();
  const result = await acceptReport(rig.h.context(rig.overrides()), rig.deps, {
    reportId: report.id,
    actor,
    punishment: 'none',
    deleteMessage: false,
    token: 'token-accept',
  });
  if (!result.ok) throw new Error(result.message);
  return rig.current(report.id);
}

function callIndex(rig: ReviewRig, method: string, path: string): number {
  return rig.h.rest.calls.findIndex((call) => call.method === method && call.path === path);
}

function postedIn(rig: ReviewRig, channelId: string): string[] {
  return rig.h.rest.calls.flatMap((call, index) => {
    if (call.method !== 'POST' || call.path !== `/channels/${channelId}/messages`) return [];
    const body = rig.h.rest.responses[index]?.body as { id?: string } | undefined;
    return [body?.id ?? ''];
  });
}

function isForwardTo(channelId: string) {
  return (call: RestRequestOptions) =>
    call.method === 'POST' &&
    call.path === `/channels/${channelId}/messages` &&
    (call.body as { message_reference?: unknown } | undefined)?.message_reference !== undefined;
}

function isClose(job: { jobId: string }): boolean {
  return job.jobId === REPORT_CLOSE_JOB;
}

function closeJobs(rig: ReviewRig) {
  return rig.h.pendingJobs().filter(isClose);
}

describe('closing', () => {
  test('keep books nothing beyond the card edit', async () => {
    const rig = reviewRig();
    await accepted(rig);

    expect(rig.h.pendingJobs().filter((job) => job.jobId === REPORT_CLOSE_JOB)).toHaveLength(0);
  });

  test('move posts the final card in the archive before deleting the originals', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    const report = await accepted(rig);
    const cardId = report.card.messageId ?? '';
    const copy = report.evidence.copy;
    if (!copy || !('messageId' in copy)) throw new Error('no copy was forwarded');

    const booked = rig.h.pendingJobs().find((job) => job.jobId === REPORT_CLOSE_JOB);
    expect(booked?.naturalKey).toBe(report.id);
    expect(booked?.data).toEqual({ reportId: report.id });
    expect(booked?.options).toEqual({ replace: true });

    await rig.closeJob();

    const archived = rig.h.sentIn(ARCHIVE_CHANNEL);
    expect(archived).toHaveLength(2);
    expect(archived[0]?.embeds?.[0]?.title).toBe(`Report \`${report.id}\` · #${report.number}`);
    expect(archived[0]?.allowed_mentions).toEqual({ parse: [] });
    expect(archived[1]?.message_reference).toMatchObject({ message_id: copy.messageId });

    const archivedAt = callIndex(rig, 'POST', `/channels/${ARCHIVE_CHANNEL}/messages`);
    const deletedAt = callIndex(rig, 'DELETE', `/channels/${REPORT_CHANNEL}/messages/${cardId}`);
    expect(archivedAt).toBeGreaterThanOrEqual(0);
    expect(deletedAt).toBeGreaterThan(archivedAt);
    expect(rig.h.deletes()).toEqual(
      expect.arrayContaining([
        { channelId: REPORT_CHANNEL, messageId: cardId },
        { channelId: REPORT_CHANNEL, messageId: copy.messageId },
      ]),
    );

    const closed = rig.current(report.id);
    const archivedCopy = postedIn(rig, ARCHIVE_CHANNEL)[1] ?? 'missing';
    expect(closed.card.state).toBe('moved');
    expect(closed.card.channelId).toBe(ARCHIVE_CHANNEL);
    expect(closed.card.messageId).not.toBe(cardId);
    expect(closed.card.evidenceMessageId).toBe(archivedCopy);
    expect(closed.evidence.copy).toEqual({ channelId: ARCHIVE_CHANNEL, messageId: archivedCopy });
    expect(closed.close.closedAt).not.toBeNull();
    expect(rig.h.keysUsed()).toContain(`moderation:report:${report.id}:archive:1`);

    expect(
      await handleCardDeleted(rig.store, GUILD, REPORT_CHANNEL, cardId, rig.h.now()),
    ).toBeNull();
  });

  test('when the archive refuses the card the original is never deleted and the patrol retries', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    const report = await accepted(rig);
    rig.h.rest.respond(
      `POST /channels/${ARCHIVE_CHANNEL}/messages`,
      discordError(403, 50001, 'Missing Access'),
      { times: 1 },
    );

    await rig.closeJob();

    expect(rig.h.deletes()).toHaveLength(0);
    const failed = rig.current(report.id);
    expect(failed.close.closedAt).toBeNull();
    expect(failed.close.error).toContain(`<#${ARCHIVE_CHANNEL}>`);
    expect(failed.card.state).toBe('posted');
    expect([...rig.store.events.values()].map((event) => event.kind)).toContain('close_failed');
    expect(closeJobs(rig)).toHaveLength(0);

    await runDeliveryPatrol(rig.h.context(rig.overrides()), rig.deps, rig.h.now());
    expect(closeJobs(rig)).toHaveLength(1);

    await rig.closeJob();
    expect(rig.current(report.id).card.state).toBe('moved');
    expect(rig.h.keysUsed()).toContain(`moderation:report:${report.id}:archive:2`);
  });

  test('a passing archive failure books the next attempt itself, with backoff', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    const report = await accepted(rig);
    rig.h.rest.respond(
      `POST /channels/${ARCHIVE_CHANNEL}/messages`,
      { status: 500, body: { message: 'Internal Server Error' } },
      { times: 1 },
    );

    await rig.closeJob();

    const [next] = closeJobs(rig);
    expect(next?.runAt.getTime()).toBe(rig.h.now() + closeBackoffMs(1));
    expect(next?.options).toEqual({ replace: true });
    expect(rig.current(report.id).close.dueAt).toBe(rig.h.now() + closeBackoffMs(1));

    await rig.closeJob();
    expect(rig.current(report.id).card.state).toBe('posted');
    expect(closeJobs(rig)).toHaveLength(1);

    rig.h.advance(closeBackoffMs(1));
    await rig.closeJob();
    expect(rig.current(report.id).card.state).toBe('moved');
  });

  test('a copy the archive refuses stays in the report channel and is never deleted', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    const report = await accepted(rig);
    const copy = report.evidence.copy;
    if (!copy || !('messageId' in copy)) throw new Error('no copy was forwarded');
    rig.h.rest.respond(isForwardTo(ARCHIVE_CHANNEL), discordError(400, 50035, 'Invalid Form Body'));

    await rig.closeJob();

    const moved = rig.current(report.id);
    expect(moved.card.state).toBe('moved');
    expect(moved.card.channelId).toBe(ARCHIVE_CHANNEL);
    expect(moved.evidence.copy).toEqual(copy);
    expect(moved.card.evidenceMessageId).toBe(copy.messageId);
    expect(rig.h.deletes()).toEqual([
      { channelId: REPORT_CHANNEL, messageId: report.card.messageId ?? '' },
    ]);

    const event = rig.store.events.get(`${report.id}:moved:close`);
    expect(event?.data).toMatchObject({ copyKept: true, copied: false });
  });

  test('a passing forward failure takes the archive card back and tries again', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    const report = await accepted(rig);
    rig.h.rest.respond(
      isForwardTo(ARCHIVE_CHANNEL),
      { status: 503, body: { message: 'Service Unavailable' } },
      { times: 1 },
    );

    await rig.closeJob();

    const [firstCard = ''] = postedIn(rig, ARCHIVE_CHANNEL);
    expect(rig.h.deletes()).toEqual([{ channelId: ARCHIVE_CHANNEL, messageId: firstCard }]);
    expect(rig.h.keysUsed()).toContain(`moderation:report:${report.id}:archive-undo:1`);
    const waiting = rig.current(report.id);
    expect(waiting.card).toMatchObject({ state: 'posted', channelId: REPORT_CHANNEL });
    expect(waiting.evidence.copy).toEqual(report.evidence.copy);

    rig.h.advance(closeBackoffMs(1));
    await rig.closeJob();

    const moved = rig.current(report.id);
    expect(moved.card.state).toBe('moved');
    expect(moved.evidence.copy).toEqual({
      channelId: ARCHIVE_CHANNEL,
      messageId: postedIn(rig, ARCHIVE_CHANNEL).at(-1) ?? '',
    });
  });

  test('a passing failure to delete the original card takes the archive side back', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    const report = await accepted(rig);
    const cardId = report.card.messageId ?? '';
    rig.h.rest.respond(
      `DELETE /channels/${REPORT_CHANNEL}/messages/${cardId}`,
      { status: 500, body: { message: 'Internal Server Error' } },
      { times: 1 },
    );

    await rig.closeJob();

    const [archived = '', archivedCopy = ''] = postedIn(rig, ARCHIVE_CHANNEL);
    expect(rig.h.deletes()).toEqual([
      { channelId: REPORT_CHANNEL, messageId: cardId },
      { channelId: ARCHIVE_CHANNEL, messageId: archived },
      { channelId: ARCHIVE_CHANNEL, messageId: archivedCopy },
    ]);
    const restored = rig.current(report.id);
    expect(restored.card).toMatchObject({
      state: 'posted',
      channelId: REPORT_CHANNEL,
      messageId: cardId,
    });
    expect(restored.evidence.copy).toEqual(report.evidence.copy);

    rig.h.advance(closeBackoffMs(1));
    await rig.closeJob();
    expect(rig.current(report.id).card.state).toBe('moved');
  });

  test('the patrol replaces a close job that has sat overdue for ten minutes', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    withArchive(rig);
    await accepted(rig);

    await runDeliveryPatrol(rig.h.context(rig.overrides()), rig.deps, rig.h.now());
    expect(rig.h.scheduledJobs.filter(isClose).at(-1)?.options).toBeUndefined();

    rig.h.advance(11 * 60_000);
    await runDeliveryPatrol(rig.h.context(rig.overrides()), rig.deps, rig.h.now());
    expect(rig.h.scheduledJobs.filter(isClose).at(-1)?.options).toEqual({ replace: true });
  });

  test('delete removes the card and the copy, and never reports them missing', async () => {
    const rig = reviewRig({ reports: { closing: { dismissed: { mode: 'delete', delay: '1h' } } } });
    const report = await rig.file();

    await dismissReport(rig.h.context(rig.overrides()), rig.deps, report.id, actor, {
      token: 'token-dismiss',
    });

    const booked = rig.h.pendingJobs().find((job) => job.jobId === REPORT_CLOSE_JOB);
    expect(booked?.runAt.getTime()).toBe(rig.h.now() + 3_600_000);

    rig.h.advance(3_600_000);
    await rig.closeJob();

    const closed = rig.current(report.id);
    expect(closed.card.state).toBe('deleted');
    expect(closed.close.closedAt).not.toBeNull();
    expect(rig.h.deletes()).toHaveLength(2);
    expect([...rig.store.events.values()].map((event) => event.kind)).toContain('deleted');
    expect([...rig.store.events.values()].map((event) => event.kind)).not.toContain('card_missing');
  });

  test('an early run re-arms itself and a closed report is left alone', async () => {
    const rig = reviewRig({ reports: { closing: { dismissed: { mode: 'delete', delay: '1h' } } } });
    const report = await rig.file();
    await dismissReport(rig.h.context(rig.overrides()), rig.deps, report.id, actor, {
      token: 'token-dismiss',
    });

    await rig.closeJob();
    expect(rig.h.deletes()).toHaveLength(0);
    expect(rig.h.pendingJobs().some((job) => job.jobId === REPORT_CLOSE_JOB)).toBe(true);

    rig.h.advance(3_600_000);
    await rig.closeJob();
    const deletes = rig.h.deletes().length;

    await rig.runClose(report.id);
    expect(rig.h.deletes()).toHaveLength(deletes);
  });

  test('the patrol re-books a due close whose job went missing', async () => {
    const rig = reviewRig({ reports: { closing: { dismissed: { mode: 'delete' } } } });
    const report = await rig.file();
    await dismissReport(rig.h.context(rig.overrides()), rig.deps, report.id, actor, {
      token: 'token-dismiss',
    });

    await rig.h.context(rig.overrides()).cancel?.(REPORT_CLOSE_JOB, report.id);
    expect(rig.h.pendingJobs().some((job) => job.jobId === REPORT_CLOSE_JOB)).toBe(false);

    await runDeliveryPatrol(rig.h.context(rig.overrides()), rig.deps, rig.h.now());
    expect(rig.h.pendingJobs().some((job) => job.jobId === REPORT_CLOSE_JOB)).toBe(true);
  });
});
