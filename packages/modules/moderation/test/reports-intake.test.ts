import { describe, expect, test } from 'bun:test';
import {
  INTERACTION_CALLBACK_MODAL,
  OptionType,
  Permissions,
  type ProtonEvent,
  parseCustomId,
  type RawOption,
} from '@proton/core';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { COMMAND_OFF_HINT, METHOD_OFF_HINT } from '../src/config.ts';
import {
  messageMenuEvent,
  modalEvent,
  pressEvent,
  rawAttachment,
  rawMessage,
  rawUser,
  slashEvent,
  userMenuEvent,
} from './drivers.ts';
import {
  ABOVE_BOT,
  BOT,
  CHANNEL,
  GUILD,
  HIGH_ROLE,
  LEFT_MEMBER,
  LOW_ROLE,
  MEMBER,
  MESSAGE,
  MOD_ROLE,
  MODERATOR,
  REPORTER,
  userOption,
} from './harness.ts';
import {
  buttonIds,
  componentIds,
  HIDDEN_CHANNEL,
  modalCustomId,
  modalOf,
  type ReportsRig,
  type RigOptions,
  reportsRig,
  textOf,
} from './reports-setup.ts';

const OTHER_GUILD = '900000000000000077';
const LINKED = '1400000000000000020';

function reportSlash(options: RawOption[] = [], settings: Parameters<typeof slashEvent>[2] = {}) {
  return slashEvent('report', [userOption('member', MEMBER), ...options], {
    userId: REPORTER,
    ...settings,
  });
}

async function open(rig: ReportsRig, event: ProtonEvent = reportSlash()): Promise<string> {
  await rig.command(event);
  return modalCustomId(rig);
}

function submit(
  customId: string,
  answers: Parameters<typeof modalEvent>[1] = { selects: { reason: ['spam'] } },
  options: Parameters<typeof modalEvent>[2] = {},
): ProtonEvent {
  return modalEvent(customId, answers, { userId: REPORTER, ...options });
}

function lastFollowUp(rig: ReportsRig) {
  const message = rig.h.followUps().at(-1);
  if (!message) throw new Error('no follow-up was sent');
  return message;
}

function reports(rig: ReportsRig) {
  return [...rig.store.rows.values()];
}

async function fileOne(options: RigOptions = {}, event?: ProtonEvent) {
  const rig = reportsRig(options);
  const customId = await open(rig, event);
  await rig.interact(submit(customId));
  return rig;
}

describe('/report', () => {
  test('opens the intake modal as the first response and keeps the draft', async () => {
    const rig = reportsRig();

    await rig.command(reportSlash());

    expect(rig.h.callbackTypes()).toEqual([INTERACTION_CALLBACK_MODAL]);
    const parsed = parseCustomId(modalCustomId(rig));
    expect(parsed?.action).toBe('rsub');
    expect(parsed?.args[0]).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(rig.drafts.entries.size).toBe(1);
    expect(String(modalOf(rig).title)).toBe('Report @member');
  });

  test('files the report, answers the reporter and announces it once saved', async () => {
    const rig = await fileOne();

    const [report] = reports(rig);
    expect(report?.method).toBe('command');
    expect(report?.reporterId).toBe(REPORTER);
    expect(report?.targetId).toBe(MEMBER);
    expect(report?.reasonId).toBe('spam');
    expect(report?.reason).toBe('Spam or flooding');
    expect(report?.number).toBe(1);

    const answer = lastFollowUp(rig);
    expect(rig.h.statusOf(answer)).toBe('success');
    expect(textOf(answer)).toContain(`Report \`${report?.id}\` filed. Staff will review it.`);
    expect(textOf(answer)).toContain('You’ll get a DM when it’s reviewed.');

    expect(rig.h.published).toEqual([
      expect.objectContaining({ type: 'moderation.report_submitted', naturalKey: report?.id }),
    ]);
    expect([...rig.store.events.values()].map((event) => event.kind)).toEqual(['submitted']);
  });

  test('the timeline and the announcement carry no reporter text', async () => {
    const rig = reportsRig();
    const customId = await open(rig);

    await rig.interact(
      submit(customId, {
        selects: { reason: ['spam'] },
        text: { custom: 'private words', comment: 'more private words' },
      }),
    );

    expect(reports(rig)[0]?.comment).toBe('more private words');
    const shared = JSON.stringify([[...rig.store.events.values()], rig.h.published]);
    expect(shared).not.toContain('private words');
    expect(rig.h.logs.some((log) => log.message.includes('private words'))).toBe(false);
  });

  test('does not promise a DM when neither review notification is on', async () => {
    const rig = await fileOne({
      reports: {
        notifications: { accepted: { enabled: false }, dismissed: { enabled: false } },
      },
    });

    expect(textOf(lastFollowUp(rig))).not.toContain('DM');
  });

  test('a redelivered modal submission files one report', async () => {
    const rig = reportsRig();
    const customId = await open(rig);
    const event = submit(customId);

    await rig.interact(event);
    await rig.interact(event);

    expect(reports(rig)).toHaveLength(1);
    const [report] = reports(rig);
    expect(rig.h.published.every((entry) => entry.naturalKey === report?.id)).toBe(true);
  });

  test('refuses when user reports are off, and files nothing', async () => {
    const rig = reportsRig({ reports: { enabled: false } });

    await rig.command(reportSlash());

    expect(rig.h.modalsOpened()).toHaveLength(0);
    expect(rig.h.statusOf(rig.h.replies()[0])).toBe('error');
    expect(textOf(rig.h.replies()[0])).toContain('User reports are off');
  });

  test('a method that is off says so and how to hide it', async () => {
    const rig = reportsRig({ reports: { methods: { command: false } } });

    await rig.command(reportSlash());

    expect(textOf(rig.h.replies()[0])).toContain('`/report` is off in this server.');
    expect(textOf(rig.h.replies()[0])).toContain(COMMAND_OFF_HINT);
    expect(textOf(rig.h.replies()[0])).not.toContain('under Apps');
  });

  test('a context menu that is off points at Apps', async () => {
    const rig = reportsRig({ reports: { methods: { userMenu: false } } });

    await rig.command(userMenuEvent('Report user', MEMBER, { userId: REPORTER }));

    expect(textOf(rig.h.replies()[0])).toContain('Apps → Report user is off');
    expect(textOf(rig.h.replies()[0])).toContain(METHOD_OFF_HINT);
  });

  test('refuses a report about yourself', async () => {
    const rig = reportsRig();

    await rig.command(slashEvent('report', [userOption('member', REPORTER)], { userId: REPORTER }));

    expect(textOf(rig.h.replies()[0])).toContain('You can’t report yourself.');
    expect(rig.drafts.entries.size).toBe(0);
  });

  test('refuses a report about a bot', async () => {
    const rig = reportsRig();

    await rig.command(
      reportSlash([], { resolved: { users: { [MEMBER]: rawUser(MEMBER, { bot: true }) } } }),
    );

    expect(textOf(rig.h.replies()[0])).toContain('Bots can’t be reported.');
  });

  test('refuses a member holding an immune role', async () => {
    const rig = reportsRig({ reports: { immuneRoleIds: [LOW_ROLE] } });

    await rig.command(reportSlash());

    expect(textOf(rig.h.replies()[0])).toContain(`<@${MEMBER}> exempt from reports`);
  });

  test('a member who has left can still be reported and holds no immune role', async () => {
    const rig = reportsRig({ reports: { immuneRoleIds: [LOW_ROLE] } });

    await rig.command(
      slashEvent('report', [userOption('member', LEFT_MEMBER)], { userId: REPORTER }),
    );
    await rig.interact(submit(modalCustomId(rig)));

    expect(reports(rig)[0]?.targetId).toBe(LEFT_MEMBER);
  });

  test('refuses and says so when drafts are not bound', async () => {
    const rig = reportsRig({ deps: { drafts: undefined } });

    await rig.command(reportSlash());

    expect(textOf(rig.h.replies()[0])).toContain('I can’t take reports right now');
  });
});

describe('who may report', () => {
  test('the block list refuses even an administrator', async () => {
    const rig = reportsRig({ reports: { blockedUserIds: [REPORTER] } });

    await rig.command(reportSlash([], { permissions: Permissions.Administrator }));

    expect(textOf(rig.h.replies()[0])).toContain('blocked you from filing reports');
  });

  test('"only these roles" refuses a member without one and admits one with it', async () => {
    const options = { reports: { reporters: { mode: 'only' as const, roleIds: [MOD_ROLE] } } };

    const refused = reportsRig(options);
    await refused.command(reportSlash());
    expect(textOf(refused.h.replies()[0])).toContain('Only members with certain roles');

    const admitted = reportsRig(options);
    await admitted.command(reportSlash([], { roleIds: [MOD_ROLE] }));
    expect(admitted.h.modalsOpened()).toHaveLength(1);
  });

  test('an administrator passes the role modes', async () => {
    const rig = reportsRig({ reports: { reporters: { mode: 'only', roleIds: [MOD_ROLE] } } });

    await rig.command(reportSlash([], { permissions: Permissions.Administrator }));

    expect(rig.h.modalsOpened()).toHaveLength(1);
  });

  test('"everyone except" refuses a member holding a listed role', async () => {
    const rig = reportsRig({ reports: { reporters: { mode: 'except', roleIds: [HIGH_ROLE] } } });

    await rig.command(reportSlash([], { roleIds: [HIGH_ROLE] }));

    expect(textOf(rig.h.replies()[0])).toContain('can’t file reports in this server');
  });

  test('the checks run again at submit: a role gained meanwhile refuses the report', async () => {
    const rig = reportsRig({ reports: { reporters: { mode: 'except', roleIds: [HIGH_ROLE] } } });
    const customId = await open(rig);

    await rig.interact(
      submit(customId, { selects: { reason: ['spam'] } }, { roleIds: [HIGH_ROLE] }),
    );

    expect(reports(rig)).toHaveLength(0);
    expect(rig.h.statusOf(lastFollowUp(rig))).toBe('error');
  });
});

describe('Report user', () => {
  test('opens the same form about the member picked', async () => {
    const rig = reportsRig();

    await rig.command(userMenuEvent('Report user', MEMBER, { userId: REPORTER }));
    await rig.interact(submit(modalCustomId(rig)));

    expect(reports(rig)[0]?.method).toBe('user_menu');
  });

  test('refuses a bot and an immune member', async () => {
    const bot = reportsRig();
    await bot.command(
      userMenuEvent('Report user', BOT, { userId: REPORTER, user: rawUser(BOT, { bot: true }) }),
    );
    expect(textOf(bot.h.replies()[0])).toContain('Bots can’t be reported.');

    const immune = reportsRig({ reports: { immuneRoleIds: [HIGH_ROLE] } });
    await immune.command(userMenuEvent('Report user', ABOVE_BOT, { userId: REPORTER }));
    expect(textOf(immune.h.replies()[0])).toContain('exempt from reports');
  });
});

describe('Report message', () => {
  function messageReport(message = rawMessage({ content: 'buy followers at scam.example' })) {
    return messageMenuEvent('Report message', { userId: REPORTER, message });
  }

  test('captures the message, offers no link field and files a message report', async () => {
    const rig = reportsRig();

    await rig.command(messageReport());
    expect(componentIds(modalOf(rig))).not.toContain('links');
    expect(String(modalOf(rig).title)).toBe('Report a message by @member');

    await rig.interact(submit(modalCustomId(rig)));

    const [report] = reports(rig);
    expect(report?.method).toBe('message_menu');
    expect(report?.sourceChannelId).toBe(CHANNEL);
    expect(report?.sourceMessageId).toBe(MESSAGE);
    expect(report?.sourceAuthorId).toBe(MEMBER);
    expect(report?.evidence.message).toMatchObject({
      status: 'captured',
      snapshot: { content: 'buy followers at scam.example', capturedFrom: 'interaction' },
    });
  });

  test.each([
    ['a bot', rawMessage({ author: rawUser(BOT, { bot: true }) }), 'Messages from bots'],
    ['a webhook', rawMessage({ webhookId: '1300000000000000001' }), 'through a webhook'],
    ['yourself', rawMessage({ authorId: REPORTER }), 'your own message'],
    ['the system', rawMessage({ type: 7 }), 'System messages'],
  ])('refuses a message from %s', async (_label, message, copy) => {
    const rig = reportsRig();

    await rig.command(messageReport(message));

    expect(rig.h.modalsOpened()).toHaveLength(0);
    expect(textOf(rig.h.replies()[0])).toContain(copy);
  });

  test('checks immunity at submit, where the author’s roles are looked up', async () => {
    const rig = reportsRig({ reports: { immuneRoleIds: [LOW_ROLE] } });

    await rig.command(messageReport());
    expect(rig.h.modalsOpened()).toHaveLength(1);

    await rig.interact(submit(modalCustomId(rig)));
    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('exempt from reports');
  });

  test('an unavailable member lookup refuses rather than guessing', async () => {
    const rig = reportsRig();
    rig.members.set(MEMBER, { state: 'unavailable', status: 503 });

    await rig.command(messageReport());
    await rig.interact(submit(modalCustomId(rig)));

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('Discord answered 503');
  });

  test('without a member lookup a message report cannot be filed', async () => {
    const rig = reportsRig({ deps: { lookupMember: undefined } });

    await rig.command(messageReport());
    await rig.interact(submit(modalCustomId(rig)));

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('can’t check whether');
  });
});

describe('the intake form', () => {
  test('stays within Discord’s five components with every field in use', async () => {
    const rig = reportsRig({ reports: { allowCustomReason: true } });

    await rig.command(reportSlash());

    const modal = modalOf(rig);
    expect(componentIds(modal)).toEqual(['reason', 'custom', 'comment', 'files', 'links']);
    expect(String(modal.title).length).toBeLessThanOrEqual(45);
  });

  test('applies the configured text limits', async () => {
    const rig = reportsRig({
      reports: {
        requireComment: true,
        limits: { commentMin: 20, commentMax: 400, customReasonMax: 80 },
      },
    });

    await rig.command(reportSlash());

    const components = modalOf(rig).components as Array<{ component: Record<string, unknown> }>;
    const byId = new Map(components.map((label) => [label.component.custom_id, label.component]));
    expect(byId.get('comment')).toMatchObject({ required: true, min_length: 20, max_length: 400 });
    expect(byId.get('custom')).toMatchObject({ max_length: 80 });
  });

  test('a shortest length left over from required details no longer refuses optional ones', async () => {
    const rig = reportsRig({ reports: { requireComment: false, limits: { commentMin: 30 } } });
    const customId = await open(rig);

    const components = modalOf(rig).components as Array<{ component: Record<string, unknown> }>;
    const comment = components.find((label) => label.component.custom_id === 'comment');
    expect(comment?.component).not.toHaveProperty('min_length');

    await rig.interact(
      submit(customId, { selects: { reason: ['spam'] }, text: { comment: 'spam bot' } }),
    );

    expect(reports(rig).map((report) => report.comment)).toEqual(['spam bot']);
  });

  test('required details need at least one character even with no shortest length set', async () => {
    const rig = reportsRig({ reports: { requireComment: true, limits: { commentMin: 0 } } });
    const customId = await open(rig);

    const components = modalOf(rig).components as Array<{ component: Record<string, unknown> }>;
    const comment = components.find((label) => label.component.custom_id === 'comment');
    expect(comment?.component).toMatchObject({ required: true, min_length: 1 });

    await rig.interact(submit(customId, { selects: { reason: ['spam'] } }));
    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('Add some details');

    await rig.interact(submit(customId, { selects: { reason: ['spam'] }, text: { comment: 'x' } }));
    expect(reports(rig)).toHaveLength(1);
  });

  test('a report that cannot be saved says nothing was filed and keeps its text out of the log', async () => {
    const rig = reportsRig();
    const customId = await open(rig);
    const draftId = parseCustomId(customId)?.args[0];
    rig.store.submit = async (input) => {
      throw new DrizzleQueryError(
        'insert into "reports" values ($1)',
        [input.comment],
        Object.assign(new Error('connection reset'), { code: '08006' }),
      );
    };

    await rig.interact(
      submit(customId, { selects: { reason: ['spam'] }, text: { comment: 'SECRET words' } }),
    );

    const answer = lastFollowUp(rig);
    expect(rig.h.statusOf(answer)).toBe('error');
    expect(textOf(answer)).toContain('I couldn’t save your report, so nothing was filed');
    expect(buttonIds(answer)).toEqual([`proton:moderation:rretry:${draftId}`]);
    expect(JSON.stringify(rig.h.logs)).not.toContain('SECRET');
    expect(JSON.stringify(rig.h.logs)).toContain('database query failed (08006)');
  });

  test('a required reason with no custom reasons makes the picker required', async () => {
    const rig = reportsRig({ reports: { allowCustomReason: false } });

    await rig.command(reportSlash());

    const components = modalOf(rig).components as Array<{ component: Record<string, unknown> }>;
    expect(components[0]?.component).toMatchObject({ custom_id: 'reason', required: true });
    expect(componentIds(modalOf(rig))).not.toContain('custom');
  });

  test('a slash attachment counts toward the limit', async () => {
    const rig = reportsRig({ reports: { maxAttachments: 2 } });
    const upload = rawAttachment({ id: '1600000000000000001', ephemeral: true });

    await rig.command(
      reportSlash([{ name: 'evidence', type: OptionType.Attachment, value: String(upload.id) }], {
        resolved: { attachments: { [String(upload.id)]: upload } },
      }),
    );

    const components = modalOf(rig).components as Array<{ component: Record<string, unknown> }>;
    const files = components.find((label) => label.component.custom_id === 'files');
    expect(files?.component).toMatchObject({ max_values: 1, required: false });

    const second = rawAttachment({ id: '1600000000000000002', filename: 'log.txt' });
    await rig.interact(
      submit(modalCustomId(rig), { selects: { reason: ['spam'] }, files: { files: [second] } }),
    );

    const [report] = reports(rig);
    expect(report?.evidence.attachments.map((file) => file.id)).toEqual([
      '1600000000000000001',
      '1600000000000000002',
    ]);
    expect(report?.evidence.attachments[0]?.expiresAt).toBeNumber();
  });

  test('missing requirements are named and "Try again" reopens the form as it was', async () => {
    const rig = reportsRig({ reports: { requireComment: true, requireAttachment: true } });
    const customId = await open(rig);
    const draftId = parseCustomId(customId)?.args[0];

    await rig.interact(
      submit(customId, { selects: { reason: ['spam'] }, text: { custom: 'raid' } }),
    );

    const refusal = lastFollowUp(rig);
    expect(reports(rig)).toHaveLength(0);
    expect(textOf(refusal)).toContain('Add some details');
    expect(textOf(refusal)).toContain('Attach at least one screenshot or file');
    expect(buttonIds(refusal)).toEqual([`proton:moderation:rretry:${draftId}`]);

    await rig.interact(pressEvent(`proton:moderation:rretry:${draftId}`, { userId: REPORTER }));
    const reopened = modalOf(rig);
    expect(reopened.custom_id).toBe(customId);
    const components = reopened.components as Array<{ component: Record<string, unknown> }>;
    expect(
      components.find((label) => label.component.custom_id === 'custom')?.component.value,
    ).toBe('raid');

    await rig.interact(
      submit(customId, {
        selects: { reason: ['spam'] },
        text: { comment: 'raided #general twice' },
        files: { files: [rawAttachment()] },
      }),
    );
    expect(reports(rig)).toHaveLength(1);
    expect(reports(rig)[0]?.comment).toBe('raided #general twice');
  });

  test('only the member who started the form can reopen it', async () => {
    const rig = reportsRig({ reports: { requireComment: true } });
    const customId = await open(rig);
    const draftId = parseCustomId(customId)?.args[0];
    await rig.interact(submit(customId));

    await rig.interact(pressEvent(`proton:moderation:rretry:${draftId}`, { userId: MODERATOR }));

    expect(textOf(rig.h.replies().at(-1))).toContain('Only the member who started this report');
  });

  test('an expired form says so and files nothing', async () => {
    const rig = reportsRig();
    const customId = await open(rig);
    rig.h.advance(16 * 60 * 1000);

    await rig.interact(submit(customId));

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('This report form expired');
  });

  test('a submission while moderation is off is answered and files nothing', async () => {
    const rig = reportsRig();
    const customId = await open(rig);

    await rig.interact(submit(customId), { config: { enabled: false } });

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('Moderation is off');
  });
});

describe('message links', () => {
  function linkTo(guildId: string, channelId: string, messageId: string): string {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  }

  test('captures what the reporter can read and nothing else', async () => {
    const rig = reportsRig();
    rig.putMessage(rawMessage({ id: LINKED, content: 'the insult' }));
    rig.putMessage(rawMessage({ id: '1400000000000000021', channelId: HIDDEN_CHANNEL }));

    const customId = await open(
      rig,
      reportSlash([
        { name: 'message', type: OptionType.String, value: linkTo(GUILD, CHANNEL, LINKED) },
      ]),
    );

    const components = modalOf(rig).components as Array<{ component: Record<string, unknown> }>;
    expect(components.find((label) => label.component.custom_id === 'links')?.component.value).toBe(
      linkTo(GUILD, CHANNEL, LINKED),
    );

    await rig.interact(
      submit(customId, {
        selects: { reason: ['harassment'] },
        text: {
          links: [
            linkTo(GUILD, CHANNEL, LINKED),
            linkTo(GUILD, HIDDEN_CHANNEL, '1400000000000000021'),
            linkTo(OTHER_GUILD, CHANNEL, '1400000000000000022'),
          ].join('\n'),
        },
      }),
    );

    const links = reports(rig)[0]?.evidence.links ?? [];
    expect(links.map((link) => link.status)).toEqual(['captured', 'no_access', 'other_server']);
    expect(links[0]?.snapshot?.content).toBe('the insult');
    expect(rig.reads).not.toContain(`${HIDDEN_CHANNEL}:1400000000000000021`);
  });

  test('a deleted linked message is recorded as not found', async () => {
    const rig = reportsRig();
    const customId = await open(rig);

    await rig.interact(
      submit(customId, {
        selects: { reason: ['spam'] },
        text: { links: linkTo(GUILD, CHANNEL, LINKED) },
      }),
    );

    expect(reports(rig)[0]?.evidence.links).toEqual([
      { url: linkTo(GUILD, CHANNEL, LINKED), status: 'not_found' },
    ]);
  });

  test('text that is not a link, or more than three links, is refused with a retry', async () => {
    const rig = reportsRig();
    const customId = await open(rig);

    await rig.interact(
      submit(customId, {
        selects: { reason: ['spam'] },
        text: {
          links: [
            'see above',
            ...['1', '2', '3'].map((n) => linkTo(GUILD, CHANNEL, `140000000000000003${n}`)),
          ].join('\n'),
        },
      }),
    );

    expect(reports(rig)).toHaveLength(0);
    expect(textOf(lastFollowUp(rig))).toContain('at most 3 message links');
    expect(textOf(lastFollowUp(rig))).toContain('isn’t a message link');
  });
});

describe('limits', () => {
  test('a cooldown refuses the next report and says when, unless the reporter may bypass it', async () => {
    const rig = await fileOne({
      reports: { limits: { cooldown: '10m', duplicateProtection: false } },
    });

    const second = await open(rig, reportSlash());
    await rig.interact(submit(second));
    expect(reports(rig)).toHaveLength(1);
    expect(textOf(lastFollowUp(rig))).toMatch(/You can file another report <t:\d+:R>\./);

    const bypass = await fileOne({
      reports: {
        limits: { cooldown: '10m', cooldownBypassRoleIds: [MOD_ROLE], duplicateProtection: false },
      },
      deps: {},
    });
    const again = await open(bypass, reportSlash([], { roleIds: [MOD_ROLE] }));
    await bypass.interact(
      submit(again, { selects: { reason: ['spam'] } }, { roleIds: [MOD_ROLE] }),
    );
    expect(reports(bypass)).toHaveLength(2);
  });

  test('duplicate protection refuses a second open report about the same member', async () => {
    const rig = await fileOne({ reports: { limits: { cooldown: '1s' } } });
    rig.h.advance(5_000);

    await rig.interact(submit(await open(rig)));

    const [first] = reports(rig);
    expect(reports(rig)).toHaveLength(1);
    expect(textOf(lastFollowUp(rig))).toContain(`Report \`${first?.id}\` is still waiting`);
  });

  test('the per-member cap refuses honestly', async () => {
    const rig = await fileOne({ reports: { limits: { maxOpenPerMember: 1 } } });

    await rig.command(slashEvent('report', [userOption('member', MEMBER)], { userId: MODERATOR }));
    await rig.interact(submit(modalCustomId(rig), undefined, { userId: MODERATOR }));

    expect(reports(rig)).toHaveLength(1);
    expect(textOf(lastFollowUp(rig))).toContain('several open reports about');
  });

  test('the server cap refuses honestly', async () => {
    const rig = await fileOne({
      reports: { limits: { maxOpenPerServer: 1, maxOpenPerMember: 1 } },
    });

    await rig.command(
      slashEvent('report', [userOption('member', ABOVE_BOT)], { userId: MODERATOR }),
    );
    await rig.interact(submit(modalCustomId(rig), undefined, { userId: MODERATOR }));

    expect(reports(rig)).toHaveLength(1);
    expect(textOf(lastFollowUp(rig))).toContain('report queue is full');
  });
});
