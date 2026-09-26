import { describe, expect, test } from 'bun:test';
import {
  encodeCustomId,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  MESSAGE_FLAG_EPHEMERAL,
  Permissions,
  type ProtonEvent,
  parseCustomId,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { openPunishFlow } from '../src/punish/flow.ts';
import { PUNISH_AUTHOR_MENU, PUNISH_FROM_MESSAGE_OFF } from '../src/punish/menu.ts';
import { EXPIRED, NOT_YOURS, REPORT_ACCEPT_UNBOUND } from '../src/punish/pending.ts';
import {
  type ComponentOptions,
  type MessageMenuOptions,
  messageMenuEvent,
  modalEvent,
  pressEvent,
  rawMessage,
  rawUser,
} from './drivers.ts';
import {
  BOT,
  CHANNEL,
  discordError,
  GUILD,
  MEMBER,
  MESSAGE,
  MOD_ROLE,
  MODERATOR,
  OWNER,
} from './harness.ts';
import { MOD_PERMISSIONS } from './punish-kit.ts';
import {
  callbacks,
  customIds,
  lastCallback,
  lastFollowUp,
  lastModal,
  modalFields,
  type PunishRig,
  type PunishRigOptions,
  punishRig,
  textOf,
} from './punish-rig.ts';

const REPORT_ID = 'Rabc123';

const REPORTED = {
  channelId: CHANNEL,
  messageId: MESSAGE,
  authorId: MEMBER,
  content: 'free nitro',
  createdAt: null,
  attachments: [],
  url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
};

function punishAuthor(options: MessageMenuOptions = {}): ProtonEvent {
  return messageMenuEvent(PUNISH_AUTHOR_MENU, {
    permissions: MOD_PERMISSIONS,
    message: rawMessage({ authorId: MEMBER, content: 'free nitro at a scam link' }),
    ...options,
  });
}

type Picker = Parameters<typeof customIds>[0];

const MOD: ComponentOptions = { permissions: MOD_PERMISSIONS };

function pickerChoices(message: Picker): string[] {
  return customIds(message).map((id) => parseCustomId(id)?.args[1] ?? '');
}

function pick(message: Picker, kind: string, options: ComponentOptions = MOD): ProtonEvent {
  const id = customIds(message).find((candidate) => parseCustomId(candidate)?.args[1] === kind);
  if (!id) throw new Error(`the picker offers no ${kind}`);
  return pressEvent(id, options);
}

function pickFrom(rig: PunishRig, kind: string, options: ComponentOptions = MOD): ProtonEvent {
  return pick(lastFollowUp(rig.h), kind, options);
}

function modalId(rig: PunishRig): string {
  const id = lastModal(rig.h).custom_id;
  if (!id) throw new Error('the modal carries no custom id');
  return id;
}

function promptFrom(message: { components?: Array<Record<string, unknown>> }): {
  go: string;
  stop: string;
  pendingId: string;
} {
  const [go, stop] = customIds(message);
  const pendingId = parseCustomId(go)?.args[0];
  if (!go || !stop || !pendingId) throw new Error('no confirm prompt');
  return { go, stop, pendingId };
}

function allowModeratorToDelete(rig: PunishRig): void {
  rig.state.roles.set(MOD_ROLE, {
    id: MOD_ROLE,
    permissions: Permissions.ManageMessages,
    position: 4,
  });
}

function casesOf(rig: PunishRig, kind: string) {
  return rig.h.cases().filter((entry) => entry.kind === kind);
}

async function openReportFlow(
  rig: PunishRig,
  start: Partial<Parameters<typeof openPunishFlow>[3]> = {},
): Promise<ProtonEvent> {
  const raccept = encodeCustomId('moderation', 'raccept', REPORT_ID);
  if (!raccept.ok) throw new Error('bad custom id');

  const event = pressEvent(raccept.customId, { permissions: MOD_PERMISSIONS });
  await openPunishFlow(event, rig.h.context(rig.overrides()), rig.deps, {
    targetId: MEMBER,
    origin: { type: 'report', reportId: REPORT_ID },
    prefillReason: 'Spam or flooding',
    reporterNoteField: true,
    ...start,
  });
  return event;
}

describe('Punish author', () => {
  test('a ban from a message deletes the message once the ban lands', async () => {
    const rig = punishRig();
    allowModeratorToDelete(rig);

    await rig.command(punishAuthor());

    expect(callbacks(rig.h).map((callback) => callback.type)).toEqual([
      INTERACTION_CALLBACK_DEFERRED_MESSAGE,
    ]);
    expect(lastFollowUp(rig.h).flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(pickerChoices(lastFollowUp(rig.h))).toEqual(['warn', 'timeout', 'kick', 'ban']);

    await rig.interact(pickFrom(rig, 'ban'));

    expect(lastCallback(rig.h).type).toBe(INTERACTION_CALLBACK_MODAL);
    const fields = modalFields(lastModal(rig.h));
    expect(fields.map((field) => field.customId)).toEqual(['reason', 'duration', 'message']);
    expect(fields[2]?.options).toEqual(['keep', 'delete']);

    await rig.interact(
      modalEvent(
        modalId(rig),
        { text: { reason: 'Scam links', duration: '' }, selects: { message: ['delete'] } },
        { permissions: MOD_PERMISSIONS },
      ),
    );

    const prompt = lastCallback(rig.h);
    expect(prompt.type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(prompt.data.content).toContain(`Ban <@${MEMBER}>?`);
    expect(prompt.data.content).toContain('The message will be deleted.');
    expect(casesOf(rig, 'ban')).toHaveLength(0);

    const { go, pendingId } = promptFrom(prompt.data);
    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));

    expect(lastCallback(rig.h).data.content).toBe('Working on it…');
    expect(rig.h.discordCalls().map((call) => `${call.method} ${call.path}`)).toEqual([
      `PUT /guilds/${GUILD}/bans/${MEMBER}`,
      `DELETE /channels/${CHANNEL}/messages/${MESSAGE}`,
    ]);

    const bans = casesOf(rig, 'ban');
    expect(bans).toHaveLength(1);
    expect(bans[0]?.reason).toBe('Scam links');
    expect(rig.h.keysUsed()).toContain(`moderation:pending:${GUILD}:${pendingId}:action`);

    const result = lastFollowUp(rig.h);
    expect(rig.h.statusOf(result)).toBe('success');
    expect(result.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(textOf(result)).toMatch(/-# Case `[A-Za-z0-9]{7}`$/);
  });

  test('a warning needs no confirmation and keeps the message when the moderator cannot delete it', async () => {
    const rig = punishRig();

    await rig.command(punishAuthor());
    await rig.interact(pickFrom(rig, 'warn'));

    expect(modalFields(lastModal(rig.h)).map((field) => field.customId)).toEqual(['reason']);

    await rig.interact(
      modalEvent(
        modalId(rig),
        { text: { reason: 'Scam links' } },
        { permissions: MOD_PERMISSIONS },
      ),
    );

    expect(lastCallback(rig.h).data.content).toBe('Working on it…');
    expect(casesOf(rig, 'warn')).toHaveLength(1);
    expect(rig.h.deletes()).toEqual([]);
    expect(rig.h.published.find((event) => event.type === 'moderation.warned')?.payload).toEqual({
      userId: MEMBER,
      channelId: CHANNEL,
    });
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('is refused, naming the setting, when punishing from a message is off', async () => {
    const rig = punishRig({ config: { punish: { punishFromMessage: false } } });

    await rig.command(punishAuthor());

    const reply = lastCallback(rig.h);
    expect(reply.type).toBe(INTERACTION_CALLBACK_CHANNEL_MESSAGE);
    expect(textOf(reply.data)).toContain(PUNISH_FROM_MESSAGE_OFF);
    expect(rig.drafts.entries.size).toBe(0);
  });

  test.each([
    ['a bot', rawMessage({ author: rawUser(BOT, { bot: true }) }), 'Bots'],
    ['a webhook', rawMessage({ webhookId: '1300000000000000001' }), 'webhook'],
    ['the invoker', rawMessage({ authorId: MODERATOR }), 'yourself'],
    ['a system message', rawMessage({ authorId: MEMBER, type: 7 }), 'System messages'],
  ])('refuses a message from %s', async (_label, message, expected) => {
    const rig = punishRig();

    await rig.command(punishAuthor({ message }));

    const reply = lastCallback(rig.h);
    expect(reply.type).toBe(INTERACTION_CALLBACK_CHANNEL_MESSAGE);
    expect(rig.h.statusOf(reply.data)).toBe('error');
    expect(textOf(reply.data)).toContain(expected);
    expect(rig.h.followUps()).toEqual([]);
  });

  test('declares the Moderate Members default permission as a guild-only message command', () => {
    const rig = punishRig();
    const menu = rig.overrides().contextMenus?.[0];

    expect(menu?.type).toBe('message');
    expect(menu?.data.default_member_permissions).toBe(String(Permissions.ModerateMembers));
    expect(menu?.data.contexts).toEqual([0]);
  });
});

describe('the punishment picker', () => {
  test('lists only the kinds the moderator holds the permission for', async () => {
    const rig = punishRig();

    await rig.command(punishAuthor({ permissions: Permissions.ModerateMembers }));

    expect(pickerChoices(lastFollowUp(rig.h))).toEqual(['warn', 'timeout']);
  });

  test('hides a kind the permissions module gates off', async () => {
    const rig = punishRig();
    rig.denied.set('timeout', 'You can’t use /timeout in this server.');

    await rig.command(punishAuthor({ permissions: Permissions.ModerateMembers }));

    expect(pickerChoices(lastFollowUp(rig.h))).toEqual(['warn']);
  });

  test('refuses, naming the permissions, when the moderator may use none of them', async () => {
    const rig = punishRig();

    await rig.command(punishAuthor({ permissions: 0n }));

    const refusal = lastFollowUp(rig.h);
    expect(rig.h.statusOf(refusal)).toBe('error');
    expect(textOf(refusal)).toContain('You need Timeout Members, Kick Members or Ban Members');
    expect(rig.drafts.entries.size).toBe(0);
  });

  test('the server owner sees every kind', async () => {
    const rig = punishRig();

    await rig.command(punishAuthor({ userId: OWNER, permissions: 0n }));

    expect(pickerChoices(lastFollowUp(rig.h))).toEqual(['warn', 'timeout', 'kick', 'ban']);
  });

  test('is a row of buttons, each carrying its punishment in a short custom id', async () => {
    const rig = punishRig();
    await openReportFlow(rig);

    const rows = lastFollowUp(rig.h).components ?? [];
    expect(rows).toHaveLength(1);
    const buttons = (rows[0]?.components ?? []) as Array<{ type: number; custom_id: string }>;
    expect(buttons.map((button) => button.type)).toEqual(Array(5).fill(ComponentType.Button));
    for (const button of buttons) expect(button.custom_id.length).toBeLessThanOrEqual(100);
  });

  test('a press on an expired picker says so', async () => {
    const rig = punishRig();
    const stale = encodeCustomId('moderation', 'ppick', 'AAAAAAAAAA', 'warn');
    if (!stale.ok) throw new Error('bad custom id');

    await rig.interact(pressEvent(stale.customId, MOD));

    expect(lastCallback(rig.h).type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(textOf(lastCallback(rig.h).data)).toContain(EXPIRED);
  });

  test('only the moderator who opened the picker can use it', async () => {
    const rig = punishRig();
    await rig.command(punishAuthor());

    await rig.interact(pickFrom(rig, 'warn', { userId: MEMBER }));

    expect(lastCallback(rig.h).type).toBe(INTERACTION_CALLBACK_CHANNEL_MESSAGE);
    expect(textOf(lastCallback(rig.h).data)).toContain(NOT_YOURS);
    expect(rig.h.modalsOpened()).toEqual([]);
  });

  test('a missing required reason swaps in a fresh picker, so the same punishment can be picked again', async () => {
    const rig = punishRig({ config: { punish: { types: { warn: { forceReason: true } } } } });
    await rig.command(punishAuthor());
    await rig.interact(pickFrom(rig, 'warn'));

    await rig.interact(modalEvent(modalId(rig), { text: { reason: '' } }, MOD));

    const refreshed = lastCallback(rig.h);
    expect(refreshed.type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(textOf(refreshed.data)).toContain('requires a reason');
    expect(pickerChoices(refreshed.data)).toEqual(['warn', 'timeout', 'kick', 'ban']);
    expect(casesOf(rig, 'warn')).toHaveLength(0);

    await rig.interact(pick(refreshed.data, 'warn'));
    expect(lastCallback(rig.h).type).toBe(INTERACTION_CALLBACK_MODAL);

    await rig.interact(modalEvent(modalId(rig), { text: { reason: 'Scam links' } }, MOD));
    expect(casesOf(rig, 'warn')).toHaveLength(1);
  });

  test('an unreadable duration answers with the picker too', async () => {
    const rig = punishRig();
    await rig.command(punishAuthor());
    await rig.interact(pickFrom(rig, 'timeout'));

    await rig.interact(
      modalEvent(modalId(rig), { text: { reason: 'Spam', duration: '2 hours' } }, MOD),
    );

    const refreshed = lastCallback(rig.h);
    expect(refreshed.type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(textOf(refreshed.data)).toContain("'2 hours'");
    expect(pickerChoices(refreshed.data)).toContain('timeout');
    expect(rig.h.cases()).toHaveLength(0);
  });

  test('a ban typed as permanent needs no duration and is not refused', async () => {
    const rig = punishRig({ config: { punish: { types: { ban: { defaultDuration: '7d' } } } } });
    await rig.command(punishAuthor());
    await rig.interact(pickFrom(rig, 'ban'));

    await rig.interact(
      modalEvent(modalId(rig), { text: { reason: 'Raid', duration: 'Permanent' } }, MOD),
    );

    const prompt = lastCallback(rig.h);
    expect(prompt.data.content).toContain('Duration: permanent');
    await rig.interact(pressEvent(promptFrom(prompt.data).go, MOD));

    expect(rig.h.scheduled).toHaveLength(0);
    expect(casesOf(rig, 'ban')).toHaveLength(1);
  });

  test('a failed first answer leaves the draft for the moderator to submit again', async () => {
    const rig = punishRig();
    await rig.command(punishAuthor());
    await rig.interact(pickFrom(rig, 'warn'));
    const customId = modalId(rig);
    rig.h.rest.respond(/^POST \/interactions\//, discordError(404, 10062, 'Unknown interaction'), {
      times: 1,
    });

    await rig.interact(modalEvent(customId, { text: { reason: 'Scam links' } }, MOD));

    expect(casesOf(rig, 'warn')).toHaveLength(0);

    await rig.interact(modalEvent(customId, { text: { reason: 'Scam links' } }, MOD));
    expect(casesOf(rig, 'warn')).toHaveLength(1);
  });
});

describe('accepting a report through the flow', () => {
  test('offers No punishment, and hands the notes to the report service', async () => {
    const rig = punishRig();
    await openReportFlow(rig);

    const picker = lastFollowUp(rig.h);
    expect(textOf(picker)).toContain(REPORT_ID);
    expect(pickerChoices(picker)).toEqual(['warn', 'timeout', 'kick', 'ban', 'none']);

    await rig.interact(pickFrom(rig, 'none'));

    const modal = lastModal(rig.h);
    expect(modal.title).toBe('Accept without punishment');
    expect(modalFields(modal).map((field) => field.customId)).toEqual(['note', 'reporter']);

    const submit = modalEvent(
      modalId(rig),
      { text: { note: 'Checked the logs', reporter: 'Thanks for flagging it' } },
      { permissions: MOD_PERMISSIONS },
    );
    await rig.interact(submit);

    expect(rig.accepts).toEqual([
      {
        reportId: REPORT_ID,
        actor: {
          id: MODERATOR,
          roleIds: [MOD_ROLE],
          permissions: MOD_PERMISSIONS,
          source: 'discord',
        },
        punishment: 'none',
        deleteMessage: false,
        note: 'Checked the logs',
        reporterNote: 'Thanks for flagging it',
        token: submit.id,
      },
    ]);
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
    expect(textOf(lastFollowUp(rig.h))).toContain('Case `Kcase01`');
  });

  test('prefills the reason from the report, and asks again when a recent case needs confirming', async () => {
    const rig = punishRig();
    rig.acceptResults.push({
      ok: false,
      code: 'recent_case',
      message: `<@${MEMBER}> was already timed out a minute ago. Time them out again?`,
      needsConfirmation: 'recent_case',
    });
    await openReportFlow(rig);

    await rig.interact(pickFrom(rig, 'timeout'));

    const fields = modalFields(lastModal(rig.h));
    expect(fields.map((field) => field.customId)).toEqual([
      'reason',
      'duration',
      'note',
      'reporter',
    ]);
    expect(fields[0]?.value).toBe('Spam or flooding');
    expect(fields[1]?.value).toBe('1h');

    await rig.interact(
      modalEvent(
        modalId(rig),
        { text: { reason: 'Spam or flooding', duration: '30m', note: '', reporter: '' } },
        { permissions: MOD_PERMISSIONS },
      ),
    );

    expect(rig.accepts).toHaveLength(1);
    expect(rig.accepts[0]).toMatchObject({ punishment: 'timeout', duration: '30m' });
    expect(rig.accepts[0]?.confirmRecentCase).toBeUndefined();

    const prompt = lastFollowUp(rig.h);
    expect(textOf(prompt)).toContain('already timed out');
    const { go } = promptFrom(prompt);

    const confirm = pressEvent(go, { permissions: MOD_PERMISSIONS });
    await rig.interact(confirm);

    expect(rig.accepts).toHaveLength(2);
    expect(rig.accepts[1]).toMatchObject({ confirmRecentCase: true, token: confirm.id });
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('a report ban is confirmed first and deletes the reported message only when chosen', async () => {
    const rig = punishRig();
    allowModeratorToDelete(rig);
    await openReportFlow(rig, {
      proof: {
        channelId: CHANNEL,
        messageId: MESSAGE,
        authorId: MEMBER,
        content: 'free nitro',
        createdAt: null,
        attachments: [],
        url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
      },
      reporterNoteField: false,
    });

    await rig.interact(pickFrom(rig, 'ban'));
    expect(modalFields(lastModal(rig.h)).map((field) => field.customId)).toEqual([
      'reason',
      'duration',
      'message',
      'note',
    ]);

    await rig.interact(
      modalEvent(
        modalId(rig),
        { text: { reason: 'Scam', duration: '7d', note: '' }, selects: { message: ['delete'] } },
        { permissions: MOD_PERMISSIONS },
      ),
    );
    expect(rig.accepts).toHaveLength(0);

    const { go } = promptFrom(lastCallback(rig.h).data);
    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));

    expect(rig.accepts[0]).toMatchObject({
      punishment: 'ban',
      reason: 'Scam',
      duration: '7d',
      deleteMessage: true,
    });
  });

  test('No punishment can still delete the reported message, and keeps it by default', async () => {
    const rig = punishRig({ config: { punish: { types: { warn: { deleteProof: true } } } } });
    allowModeratorToDelete(rig);
    await openReportFlow(rig, { proof: REPORTED, reporterNoteField: false });

    await rig.interact(pickFrom(rig, 'none'));

    const fields = modalFields(lastModal(rig.h));
    expect(fields.map((field) => field.customId)).toEqual(['message', 'note']);
    expect(fields[0]?.options).toEqual(['keep', 'delete']);
    const [select] = (lastModal(rig.h).components ?? []) as Array<{
      component?: { options?: unknown[] };
    }>;
    expect(select?.component?.options?.[0]).toMatchObject({ value: 'keep', default: true });

    await rig.interact(
      modalEvent(modalId(rig), { text: { note: '' }, selects: { message: ['delete'] } }, MOD),
    );

    expect(rig.accepts[0]).toMatchObject({ punishment: 'none', deleteMessage: true });
  });

  test('No punishment offers no message choice to a moderator who cannot delete it', async () => {
    const rig = punishRig();
    await openReportFlow(rig, { proof: REPORTED, reporterNoteField: false });

    await rig.interact(pickFrom(rig, 'none'));
    expect(modalFields(lastModal(rig.h)).map((field) => field.customId)).toEqual(['note']);

    await rig.interact(modalEvent(modalId(rig), { text: { note: '' } }, MOD));
    expect(rig.accepts[0]).toMatchObject({ punishment: 'none', deleteMessage: false });
  });

  test('refuses to start when report acceptance is not connected', async () => {
    const rig = punishRig({ deps: { reportAccept: undefined } } satisfies PunishRigOptions);

    await openReportFlow(rig);

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('error');
    expect(textOf(lastFollowUp(rig.h))).toContain(REPORT_ACCEPT_UNBOUND);
    expect(rig.drafts.entries.size).toBe(0);
  });
});
