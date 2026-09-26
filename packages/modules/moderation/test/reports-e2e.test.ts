import { describe, expect, test } from 'bun:test';
import {
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  parseCustomId,
} from '@proton/core';
import { createReportSubmittedListener } from '../src/reports/delivery.ts';
import { STILL_OPEN } from '../src/reports/review.ts';
import type { ReportRecord } from '../src/reports/types.ts';
import { messageMenuEvent, modalEvent, pressEvent, rawMessage, slashEvent } from './drivers.ts';
import { CHANNEL, discordError, userOption } from './harness.ts';
import {
  ARCHIVE_CHANNEL,
  customIdsOf,
  fieldValue,
  GUILD,
  MEMBER,
  MODERATOR,
  NOW,
  REPORT_CHANNEL,
  REPORTER,
  REVIEWER_PERMISSIONS,
  type ReviewRig,
  reviewRig,
} from './reports-review-setup.ts';
import { modalCustomId, textOf } from './reports-setup.ts';

const LINKED = '1400000000000000020';

const asModerator = { userId: MODERATOR, permissions: REVIEWER_PERMISSIONS };

function onlyReport(rig: ReviewRig): ReportRecord {
  const [report, extra] = [...rig.store.rows.values()];
  if (!report || extra) throw new Error('expected exactly one report');
  return rig.current(report.id);
}

async function deliverPublished(rig: ReviewRig): Promise<void> {
  const published = rig.h.publishedEvents.filter(
    (event) => event.type === 'moderation.report_submitted',
  );
  for (const event of published) {
    await rig.h.listen(event, [createReportSubmittedListener(rig.deps)], rig.overrides());
  }
}

function lastFollowUp(rig: ReviewRig) {
  const message = rig.h.followUps().at(-1);
  if (!message) throw new Error('nothing was followed up');
  return message;
}

function firstId(message: { components?: Array<Record<string, unknown>> }): string {
  const [id] = customIdsOf(message);
  if (!id) throw new Error('the message carries no component');
  return id;
}

describe('end to end', () => {
  test('(1) Report message → card → accept with a ban → resolved → moved to the archive', async () => {
    const rig = reviewRig({
      reports: { closing: { accepted: { mode: 'move', channelId: ARCHIVE_CHANNEL } } },
    });
    rig.state.channels.set(ARCHIVE_CHANNEL, {
      id: ARCHIVE_CHANNEL,
      parentId: null,
      overwrites: [],
    });

    await rig.command(
      messageMenuEvent('Report message', {
        userId: REPORTER,
        message: rawMessage({ authorId: MEMBER, content: 'free nitro at scam.example' }),
      }),
    );
    await rig.route(
      modalEvent(modalCustomId(rig), { selects: { reason: ['scam'] } }, { userId: REPORTER }),
    );

    const filed = onlyReport(rig);
    expect(filed.method).toBe('message_menu');
    expect(filed.evidence.message?.status).toBe('captured');

    await deliverPublished(rig);
    const posted = onlyReport(rig);
    expect(posted.card.state).toBe('posted');
    expect(rig.cardPosts()).toHaveLength(1);

    await rig.press('raccept', posted);
    const picker = lastFollowUp(rig);
    expect(picker.content).toContain(`Accepting report \`${posted.id}\``);

    const ban = customIdsOf(picker).find((id) => parseCustomId(id)?.args[1] === 'ban');
    await rig.route(pressEvent(ban ?? '', asModerator));
    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_MODAL);
    const modal = rig.h.modalsOpened().at(-1) as { custom_id?: string; components?: unknown[] };
    expect(JSON.stringify(modal.components)).toContain('Scam or suspicious link');

    await rig.route(
      modalEvent(
        modal.custom_id ?? '',
        {
          text: {
            reason: 'Scam links',
            duration: '',
            note: 'third report this week',
            reporter: 'Thanks for flagging it.',
          },
        },
        asModerator,
      ),
    );

    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    const prompt = rig.h.replies().at(-1) ?? {};
    const go = firstId(prompt);
    expect(parseCustomId(go)?.action).toBe('pgo');

    await rig.route(pressEvent(go, asModerator));

    const accepted = onlyReport(rig);
    expect(accepted.status).toBe('accepted');
    expect(accepted.actionKind).toBe('ban');
    expect(accepted.caseIds).toHaveLength(1);
    expect(accepted.resolutionNote).toBe('third report this week');
    expect(accepted.reporterNote).toBe('Thanks for flagging it.');
    expect(rig.h.cases().filter((entry) => entry.kind === 'ban')).toHaveLength(1);
    expect(rig.h.statusOf(lastFollowUp(rig))).toBe('success');
    expect(textOf(lastFollowUp(rig))).toContain(`Case \`${accepted.caseIds[0]}\``);

    const cardEdit = rig.h.edits().at(-1);
    expect(fieldValue(cardEdit?.message, 'Status')).toContain(`Accepted by <@${MODERATOR}> · Ban`);
    expect(rig.h.dms().some((dm) => dm.userId === REPORTER)).toBe(true);

    await rig.closeJob();

    const moved = onlyReport(rig);
    expect(moved.card.state).toBe('moved');
    expect(moved.card.channelId).toBe(ARCHIVE_CHANNEL);
    expect(rig.h.sentIn(ARCHIVE_CHANNEL).length).toBeGreaterThanOrEqual(1);
    expect(rig.h.deletes()).toEqual(
      expect.arrayContaining([{ channelId: REPORT_CHANNEL, messageId: posted.card.messageId }]),
    );
  });

  test('(2) /report with a link → dismissed with a note → the reporter reads the note', async () => {
    const rig = reviewRig({
      reports: {
        notifications: {
          dismissed: {
            enabled: true,
            message: {
              embeds: [
                {
                  title: 'Your report was reviewed',
                  description: 'Report `{report.id}`: {report.explanation}',
                },
              ],
            },
          },
        },
      },
    });
    rig.putMessage(rawMessage({ id: LINKED, authorId: MEMBER, content: 'the insult' }));

    await rig.command(slashEvent('report', [userOption('member', MEMBER)], { userId: REPORTER }));
    await rig.route(
      modalEvent(
        modalCustomId(rig),
        {
          selects: { reason: ['harassment'] },
          text: { links: `https://discord.com/channels/${GUILD}/${CHANNEL}/${LINKED}` },
        },
        { userId: REPORTER },
      ),
    );

    const filed = onlyReport(rig);
    expect(filed.method).toBe('command');
    expect(filed.evidence.links.map((link) => link.status)).toEqual(['captured']);

    await deliverPublished(rig);
    const posted = onlyReport(rig);
    expect(fieldValue(rig.cardPosts()[0], 'Evidence')).toBe('1 linked message');

    await rig.press('rdismiss', posted);
    const modal = rig.h.modalsOpened().at(-1) as { custom_id?: string };

    await rig.route(
      modalEvent(
        modal.custom_id ?? '',
        { text: { note: 'banter between friends', reporter: 'We read it and it was banter.' } },
        { ...asModerator, channelId: REPORT_CHANNEL },
      ),
    );

    const dismissed = onlyReport(rig);
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.notifications.dismissed?.outcome).toBe('sent');

    const dm = rig.h
      .dms()
      .filter((entry) => entry.userId === REPORTER)
      .at(-1);
    const told = JSON.stringify(dm?.message);
    expect(told).toContain(`Report \`${dismissed.id}\`: We read it and it was banter.`);
    expect(told).not.toContain('banter between friends');
    expect(dm?.message.allowed_mentions).toEqual({ parse: [] });

    expect(fieldValue(rig.h.edits().at(-1)?.message, 'Status')).toBe(
      `Dismissed by <@${MODERATOR}>`,
    );
  });

  test('(3) a refused card is retried from the dashboard, and a failed timeout can be retried', async () => {
    const rig = reviewRig();
    rig.h.advance(Date.now() - NOW);

    rig.h.rest.respond(
      `POST /channels/${REPORT_CHANNEL}/messages`,
      discordError(403, 50013, 'Missing Permissions'),
      { times: 1 },
    );

    const report = await rig.file();
    expect(report.card.state).toBe('failed');

    const retried = await rig.request('retry_delivery', report.id);
    expect(retried?.ok).toBe(true);
    expect(rig.current(report.id).card.state).toBe('posted');

    rig.h.rest.respond(
      /PATCH \/guilds\/\d+\/members\/\d+/,
      discordError(403, 50013, 'Missing Permissions'),
      { times: 1 },
    );

    const failed = await rig.request('accept', report.id, {
      punishment: 'timeout',
      duration: '1h',
      reason: 'Spam',
    });
    expect(failed?.ok).toBe(false);
    expect(failed?.message).toContain(STILL_OPEN);
    expect(rig.current(report.id).status).toBe('open');
    expect([...rig.store.events.values()].map((event) => event.kind)).toContain('action_failed');

    const succeeded = await rig.request('accept', report.id, {
      punishment: 'timeout',
      duration: '1h',
      reason: 'Spam',
    });
    expect(succeeded?.ok).toBe(true);
    expect(rig.current(report.id).status).toBe('accepted');
    expect(rig.current(report.id).actionKind).toBe('timeout');
    expect(rig.h.cases().filter((entry) => entry.kind === 'timeout')).toHaveLength(1);
    expect(rig.timeouts.rows.size).toBe(1);
  });
});
