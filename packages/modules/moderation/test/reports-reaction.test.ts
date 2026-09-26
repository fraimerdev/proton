import { describe, expect, test } from 'bun:test';
import { type ProtonEvent, parseCustomId } from '@proton/core';
import {
  createPromptCleanupHandler,
  handleReportReaction,
  PROMPT_CLEANUP_JOB,
} from '../src/reports/reaction.ts';
import { modalEvent, pressEvent, rawMessage, rawUser, reactionEvent } from './drivers.ts';
import {
  BOT,
  BOT_PERMISSIONS,
  CHANNEL,
  DM_CHANNEL,
  discordError,
  dmChannelFor,
  GUILD,
  LOW_ROLE,
  MEMBER,
  MESSAGE,
  MODERATOR,
  REPORTER,
} from './harness.ts';
import {
  buttonIds,
  modalCustomId,
  REPORT_CHANNEL,
  type ReportsRig,
  type RigOptions,
  reportsRig,
  textOf,
} from './reports-setup.ts';

const FLAG = encodeURIComponent('🚩');
const REPORTER_DM = dmChannelFor(REPORTER);

function reactionRig(options: RigOptions = {}): ReportsRig {
  return reportsRig({
    ...options,
    reports: {
      methods: { reaction: true },
      reaction: { reasonId: 'spam' },
      ...options.reports,
    },
  });
}

function reports(rig: ReportsRig) {
  return [...rig.store.rows.values()];
}

function dmsTo(rig: ReportsRig, userId: string) {
  return rig.h.dms().filter((dm) => dm.userId === userId && dm.status < 400);
}

function postedId(rig: ReportsRig, channelId: string): string {
  const index = rig.h.rest.calls.findIndex(
    (call) => call.method === 'POST' && call.path === `/channels/${channelId}/messages`,
  );
  const body = rig.h.rest.responses[index]?.body as { id?: string } | undefined;
  return body?.id ?? '';
}

function flag(options: Parameters<typeof reactionEvent>[0] = {}): ProtonEvent {
  return reactionEvent({ userId: REPORTER, ...options });
}

describe('a reaction that says it all', () => {
  test('files at once, removes the reaction and DMs the outcome', async () => {
    const rig = reactionRig();
    rig.putMessage(rawMessage({ content: 'free nitro at scam.example' }));
    const event = flag();

    await rig.react(event);

    const [report] = reports(rig);
    expect(report?.method).toBe('reaction');
    expect(report?.reasonId).toBe('spam');
    expect(report?.idempotencyKey).toBe(`moderation:report:reaction:${event.id}`);
    expect(report?.evidence.message).toMatchObject({
      status: 'captured',
      snapshot: { content: 'free nitro at scam.example', capturedFrom: 'rest' },
    });

    const removal = rig.h.rest.calls.find((call) => call.method === 'DELETE');
    expect(removal?.path).toBe(
      `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/${FLAG}/${REPORTER}`,
    );

    const [dm] = dmsTo(rig, REPORTER);
    expect(rig.h.statusOf(dm?.message)).toBe('success');
    expect(textOf(dm?.message)).toContain(`Report \`${report?.id}\` filed.`);
    expect(rig.h.published.map((entry) => entry.naturalKey)).toEqual([report?.id ?? '']);
  });

  test('leaves the confirmation to the submitted notification when it is on', async () => {
    const rig = reactionRig({ reports: { notifications: { submitted: { enabled: true } } } });

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(1);
    expect(dmsTo(rig, REPORTER)).toHaveLength(0);
  });

  test('an unreadable message is still a report about its author', async () => {
    const rig = reactionRig();

    await rig.react(flag());

    expect(reports(rig)[0]?.evidence.message).toEqual({
      status: 'unavailable',
      reason: 'deleted',
      ids: { channelId: CHANNEL, messageId: MESSAGE },
    });
  });

  test('a message with no known author and no read is refused by DM', async () => {
    const rig = reactionRig();

    await rig.react(flag({ messageAuthorId: null }));

    expect(reports(rig)).toHaveLength(0);
    const [dm] = dmsTo(rig, REPORTER);
    expect(rig.h.statusOf(dm?.message)).toBe('error');
    expect(textOf(dm?.message)).toContain('I couldn’t read the message you flagged');
  });

  test('an uncached message is read to find its author', async () => {
    const rig = reactionRig();
    rig.putMessage(rawMessage());

    await rig.react(flag({ messageAuthorId: null }));

    expect(reports(rig)[0]?.targetId).toBe(MEMBER);
  });

  test('a failed removal is logged with what is missing and the report still lands', async () => {
    const rig = reactionRig({ botPermissions: BOT_PERMISSIONS });

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(1);
    const warning = rig.h.logs.find((log) => log.message.includes('report reaction'));
    expect(warning?.message).toContain('Manage Messages');
  });

  test('keeps the reaction when removal is off', async () => {
    const rig = reactionRig({ reports: { reaction: { reasonId: 'spam', removeReaction: false } } });

    await rig.react(flag());

    expect(rig.h.rest.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(reports(rig)).toHaveLength(1);
  });
});

describe('what a reaction is ignored for', () => {
  test.each([
    ['another emoji', flag({ emoji: { id: null, name: '👍' } })],
    ['a bot', flag({ bot: true })],
    ['Proton itself', reactionEvent({ userId: BOT })],
    ['the report channel', flag({ channelId: REPORT_CHANNEL })],
    ['a removal', flag({ removed: true })],
  ])('%s', async (_label, event) => {
    const rig = reactionRig();

    await rig.react(event);

    expect(reports(rig)).toHaveLength(0);
    expect(rig.h.rest.calls).toHaveLength(0);
  });

  test('channels outside "only these channels"', async () => {
    const rig = reactionRig({
      reports: {
        reaction: { reasonId: 'spam', channelMode: 'only', channelIds: [REPORT_CHANNEL] },
      },
    });

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
  });

  test('reports switched off, or the reaction method off', async () => {
    const off = reactionRig({ reports: { enabled: false } });
    await off.react(flag());
    expect(off.h.rest.calls).toHaveLength(0);

    const method = reactionRig({ reports: { methods: { reaction: false } } });
    await method.react(flag());
    expect(method.h.rest.calls).toHaveLength(0);
  });

  test('a custom emoji matches by id', async () => {
    const rig = reactionRig({
      reports: { reaction: { reasonId: 'spam', emoji: '<:report:1350000000000000001>' } },
    });

    await rig.react(flag({ emoji: { id: '1350000000000000001', name: 'report' } }));

    expect(reports(rig)).toHaveLength(1);
    expect(rig.h.rest.calls.find((call) => call.method === 'DELETE')?.path).toContain(
      encodeURIComponent('report:1350000000000000001'),
    );
  });
});

describe('duplicates and redelivery', () => {
  test('a second reaction within ten minutes is dropped, but its flag is still removed', async () => {
    const rig = reactionRig();

    await rig.react(flag());
    await rig.react(flag());

    expect(reports(rig)).toHaveLength(1);
    expect(dmsTo(rig, REPORTER)).toHaveLength(1);
    expect(rig.h.rest.calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    expect(rig.reads).toHaveLength(1);
  });

  test('a redelivered event runs again but files and tells once', async () => {
    const rig = reactionRig();
    const event = flag();

    await rig.react(event);
    await rig.react(event);

    expect(reports(rig)).toHaveLength(1);
    expect(dmsTo(rig, REPORTER)).toHaveLength(1);
  });

  test('the gate is released when handling throws, so a retry is not dropped', async () => {
    const rig = reactionRig();
    const submit = rig.store.submit.bind(rig.store);
    rig.store.submit = async () => {
      throw new Error('database down');
    };

    await expect(rig.react(flag())).rejects.toThrow('database down');
    expect(rig.gate.held.size).toBe(0);

    rig.store.submit = submit;
    await rig.react(flag());
    expect(reports(rig)).toHaveLength(1);
  });

  test('flagging a message again once its report was resolved files a new report', async () => {
    const rig = reactionRig();

    await rig.react(flag());
    const [first] = reports(rig);
    if (!first) throw new Error('nothing was filed');
    const stored = rig.store.rows.get(first.id);
    if (stored) stored.status = 'dismissed';

    rig.h.advance(11 * 60_000);
    await rig.react(flag());

    const filed = reports(rig);
    expect(filed).toHaveLength(2);
    const second = filed.find((report) => report.id !== first.id);
    expect(textOf(dmsTo(rig, REPORTER).at(-1)?.message)).toContain(`Report \`${second?.id}\``);
    expect(rig.h.published.map((entry) => entry.naturalKey)).toEqual([first.id, second?.id ?? '']);
  });

  test('flagging again while the report is still open is answered as a duplicate', async () => {
    const rig = reactionRig();

    await rig.react(flag());
    rig.h.advance(11 * 60_000);
    await rig.react(flag());

    const [report] = reports(rig);
    expect(reports(rig)).toHaveLength(1);
    const answer = dmsTo(rig, REPORTER).at(-1)?.message;
    expect(rig.h.statusOf(answer)).toBe('error');
    expect(textOf(answer)).toContain(`Report \`${report?.id}\` is still waiting for staff`);
  });

  test('a redelivered event does not announce a report whose card is already out', async () => {
    const rig = reactionRig();
    const event = flag();

    await rig.react(event);
    const [report] = reports(rig);
    if (!report) throw new Error('nothing was filed');
    await rig.store.rememberCard(GUILD, report.id, {
      channelId: REPORT_CHANNEL,
      messageId: '1400000000000000300',
    });

    await rig.react(event);

    expect(rig.h.published).toHaveLength(1);
  });

  test('a refusal frees the message, so the member can flag it again when told to', async () => {
    const rig = reactionRig({ reports: { limits: { cooldown: '2m' } } });
    const other = '1400000000000000099';

    await rig.react(flag());
    rig.h.advance(60_000);
    await rig.react(flag({ messageId: other }));
    expect(textOf(dmsTo(rig, REPORTER).at(-1)?.message)).toContain('You can file another report');

    rig.h.advance(2 * 60_000);
    await rig.react(flag({ messageId: other }));

    expect(reports(rig).map((report) => report.sourceMessageId)).toEqual([MESSAGE, other]);
  });

  test('a blocked reporter costs no message read', async () => {
    const rig = reactionRig({ reports: { blockedUserIds: [REPORTER] } });

    await rig.react(flag({ messageAuthorId: null }));

    expect(rig.reads).toEqual([]);
    expect(textOf(dmsTo(rig, REPORTER)[0]?.message)).toContain('blocked you');
  });
});

describe('refusals reach the reactor by DM', () => {
  test('a blocked reporter', async () => {
    const rig = reactionRig({ reports: { blockedUserIds: [REPORTER] } });

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(dmsTo(rig, REPORTER)[0]?.message)).toContain('blocked you');
  });

  test('their own message', async () => {
    const rig = reactionRig();

    await rig.react(flag({ messageAuthorId: REPORTER }));

    expect(textOf(dmsTo(rig, REPORTER)[0]?.message)).toContain('your own message');
  });

  test('an immune author', async () => {
    const rig = reactionRig({
      reports: { immuneRoleIds: [LOW_ROLE], reaction: { reasonId: 'spam' } },
    });

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(dmsTo(rig, REPORTER)[0]?.message)).toContain('exempt from reports');
  });

  test('an author Proton could not look up', async () => {
    const rig = reactionRig();
    rig.members.set(MEMBER, { state: 'unavailable', status: 500 });

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(dmsTo(rig, REPORTER)[0]?.message)).toContain('Discord answered 500');
  });

  test('a bot author, once the message is read', async () => {
    const rig = reactionRig();
    rig.putMessage(rawMessage({ author: rawUser(MEMBER, { bot: true }) }));

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(dmsTo(rig, REPORTER)[0]?.message)).toContain('Messages from bots');
  });

  test('a cooldown', async () => {
    const rig = reactionRig({ reports: { limits: { cooldown: '10m' } } });

    await rig.react(flag());
    await rig.react(flag({ messageId: '1400000000000000099' }));

    expect(reports(rig)).toHaveLength(1);
    expect(textOf(dmsTo(rig, REPORTER).at(-1)?.message)).toContain('You can file another report');
  });
});

describe('a reaction that needs more', () => {
  const needsDetails = { reports: { requireComment: true, reaction: { reasonId: 'spam' } } };

  test('DMs a Finish report button and files nothing yet', async () => {
    const rig = reactionRig(needsDetails);

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
    const [dm] = dmsTo(rig, REPORTER);
    expect(textOf(dm?.message)).toContain('some details');
    const [button] = buttonIds(dm?.message ?? {});
    expect(button).toMatch(new RegExp(`^proton:moderation:rfin:${GUILD}:[A-Za-z0-9]{10}$`));
  });

  test('the DM button opens the form there and the DM submission files the report', async () => {
    const rig = reactionRig(needsDetails);
    await rig.react(flag());
    const button = buttonIds(dmsTo(rig, REPORTER)[0]?.message ?? {})[0] ?? '';
    const draftId = parseCustomId(button)?.args[1];

    await rig.interact(pressEvent(button, { guildId: null, userId: REPORTER }));

    const customId = modalCustomId(rig);
    expect(customId).toBe(`proton:moderation:rsubd:${GUILD}:${draftId}`);

    await rig.interact(
      modalEvent(
        customId,
        { selects: { reason: ['spam'] }, text: { comment: 'posted it in five channels' } },
        { guildId: null, userId: REPORTER },
      ),
    );

    const [report] = reports(rig);
    expect(report?.method).toBe('reaction');
    expect(report?.comment).toBe('posted it in five channels');
    expect(report?.sourceMessageId).toBe(MESSAGE);

    const answer = rig.h.followUps().at(-1);
    expect(rig.h.statusOf(answer)).toBe('success');
    expect(answer?.flags).toBeUndefined();
  });

  test('a DM failure to validate offers the same Finish button to try again', async () => {
    const rig = reactionRig(needsDetails);
    await rig.react(flag());
    const button = buttonIds(dmsTo(rig, REPORTER)[0]?.message ?? {})[0] ?? '';
    await rig.interact(pressEvent(button, { guildId: null, userId: REPORTER }));

    await rig.interact(
      modalEvent(
        modalCustomId(rig),
        { selects: { reason: ['spam'] } },
        { guildId: null, userId: REPORTER },
      ),
    );

    expect(reports(rig)).toHaveLength(0);
    expect(buttonIds(rig.h.followUps().at(-1) ?? {})).toEqual([button]);
  });

  test('only the reactor can use the button', async () => {
    const rig = reactionRig(needsDetails);
    await rig.react(flag());
    const button = buttonIds(dmsTo(rig, REPORTER)[0]?.message ?? {})[0] ?? '';

    await rig.interact(pressEvent(button, { guildId: null, userId: MODERATOR }));

    expect(rig.h.modalsOpened()).toHaveLength(0);
    expect(textOf(rig.h.replies().at(-1))).toContain('Only the member who started this report');
  });

  test('a reactor who left the server cannot finish from DMs', async () => {
    const rig = reactionRig(needsDetails);
    await rig.react(flag());
    const button = buttonIds(dmsTo(rig, REPORTER)[0]?.message ?? {})[0] ?? '';
    await rig.interact(pressEvent(button, { guildId: null, userId: REPORTER }));
    rig.members.set(REPORTER, { state: 'absent' });

    await rig.interact(
      modalEvent(
        modalCustomId(rig),
        { selects: { reason: ['spam'] }, text: { comment: 'spam' } },
        { guildId: null, userId: REPORTER },
      ),
    );

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(rig.h.followUps().at(-1))).toContain('no longer a member');
  });

  test('pressing the button after filing says it was filed', async () => {
    const rig = reactionRig(needsDetails);
    await rig.react(flag());
    const button = buttonIds(dmsTo(rig, REPORTER)[0]?.message ?? {})[0] ?? '';
    await rig.interact(pressEvent(button, { guildId: null, userId: REPORTER }));
    await rig.interact(
      modalEvent(
        modalCustomId(rig),
        { selects: { reason: ['spam'] }, text: { comment: 'spam' } },
        { guildId: null, userId: REPORTER },
      ),
    );

    await rig.interact(pressEvent(button, { guildId: null, userId: REPORTER }));

    expect(rig.h.modalsOpened()).toHaveLength(1);
    expect(textOf(rig.h.replies().at(-1))).toContain('You already filed report');
  });

  test('closed DMs and the fallback on: a two-minute prompt in the channel, then removed', async () => {
    const rig = reactionRig({
      reports: { requireComment: true, reaction: { reasonId: 'spam', channelFallback: true } },
    });
    rig.h.rest.respond(
      'POST /users/@me/channels',
      discordError(403, 50007, 'Cannot send messages'),
    );

    await rig.react(flag());

    const [prompt] = rig.h.sentIn(CHANNEL);
    expect(prompt?.content).toContain(`<@${REPORTER}>`);
    expect(prompt?.allowed_mentions).toEqual({ parse: [], users: [REPORTER] });
    expect(buttonIds(prompt ?? {})[0]).toMatch(/^proton:moderation:rfin:/);

    const promptId = postedId(rig, CHANNEL);
    const [job] = rig.h.pendingJobs();
    expect(job?.jobId).toBe(PROMPT_CLEANUP_JOB);
    expect(job?.naturalKey).toBe(promptId);
    expect(job?.runAt.getTime()).toBe(rig.h.now() + 2 * 60 * 1000);
    expect(await rig.prompts.overdue(GUILD, rig.h.now() + 3 * 60 * 1000, 10)).toEqual([
      { channelId: CHANNEL, messageId: promptId, dueAt: rig.h.now() + 2 * 60 * 1000 },
    ]);

    rig.h.advance(2 * 60 * 1000);
    await rig.h.runDue(
      rig.overrides({ handlers: { [PROMPT_CLEANUP_JOB]: createPromptCleanupHandler(rig.deps) } }),
    );

    expect(rig.h.deletes()).toContainEqual({ channelId: CHANNEL, messageId: promptId });
    expect(await rig.prompts.overdue(GUILD, rig.h.now() + 60_000, 10)).toEqual([]);
  });

  test('closed DMs and the fallback off: nothing filed, nothing posted', async () => {
    const rig = reactionRig(needsDetails);
    rig.h.rest.respond(
      'POST /users/@me/channels',
      discordError(403, 50007, 'Cannot send messages'),
    );

    await rig.react(flag());

    expect(reports(rig)).toHaveLength(0);
    expect(rig.h.sentIn(CHANNEL)).toHaveLength(0);
    expect(rig.h.logs.some((log) => log.message.includes('channel fallback is off'))).toBe(true);
    expect(rig.gate.held.size).toBe(0);
  });

  test('both routes failing is logged with the reason', async () => {
    const rig = reactionRig({
      reports: { requireComment: true, reaction: { reasonId: 'spam', channelFallback: true } },
    });
    rig.h.rest.respond(
      'POST /users/@me/channels',
      discordError(403, 50007, 'Cannot send messages'),
    );
    rig.h.rest.respond(
      `POST /channels/${CHANNEL}/messages`,
      discordError(403, 50013, 'Missing Permissions'),
    );

    const outcome = await handleReportReaction(flag(), rig.h.context(rig.overrides()), rig.deps);

    expect(outcome).toEqual({ action: 'undelivered' });
    expect(rig.h.logs.some((log) => log.message.includes('could neither DM them'))).toBe(true);
  });

  test('the DM channel is remembered between messages', async () => {
    const rig = reactionRig(needsDetails);

    await rig.react(flag());

    expect(await rig.deps.dmChannels?.recall(GUILD, REPORTER)).toBe(REPORTER_DM);
    expect(DM_CHANNEL).not.toBe(REPORTER_DM);
  });

  test('an unreadable message still names its author in the form, from the user directory', async () => {
    const rig = reactionRig({
      ...needsDetails,
      deps: {
        users: {
          resolve: async (userId) => ({
            id: userId,
            username: 'nova',
            globalName: 'Nova',
            avatarUrl: null,
            avatarHash: null,
          }),
        },
      },
    });
    await rig.react(flag());
    const button = buttonIds(dmsTo(rig, REPORTER)[0]?.message ?? {})[0] ?? '';

    await rig.interact(pressEvent(button, { guildId: null, userId: REPORTER }));

    expect(rig.h.modalsOpened()[0]?.title).toBe('Report a message by @nova');
  });
});
