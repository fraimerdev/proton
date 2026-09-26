import { describe, expect, test } from 'bun:test';
import {
  type ActionKind,
  type ActionRequest,
  type CommandContext,
  type CommandDefinition,
  type ContextMenuContext,
  type ContextMenuDefinition,
  deferEphemeral,
  type EventListener,
  errorStatus,
  followUp,
  interactionRef,
  type ModuleContext,
  OptionType,
  openModal,
  Permissions,
  type ProtonEvent,
  readAutocompleteInteraction,
  readComponentInteraction,
  readMemberPermissions,
  readModalInteraction,
  replyEphemeral,
  successStatus,
  UndeclaredScheduleError,
  updateMessage,
} from '@proton/core';
import { ApplicationCommandType, RESTJSONErrorCodes } from 'discord-api-types/v10';
import type { ModerationConfig } from '../src/config.ts';
import {
  autocompleteEvent,
  configChangedEvent,
  fixtureEvent,
  type ModalAnswers,
  messageDeletedEvent,
  messageMenuEvent,
  modalEvent,
  pressEvent,
  rawAttachment,
  rawMessage,
  reactionEvent,
  slashEvent,
  userMenuEvent,
} from './drivers.ts';
import {
  APPLICATION_ID,
  BOT_PERMISSIONS,
  baseGuildState,
  CHANNEL,
  DM_CHANNEL,
  discordError,
  dmChannelFor,
  GUILD,
  harness,
  LEFT_MEMBER,
  MEMBER,
  MESSAGE,
  MOD_ROLE,
  MODERATOR,
  REPORTER,
  userOption,
} from './harness.ts';

type Ctx = ModuleContext<ModerationConfig>;

function action(
  ctx: Ctx,
  kind: ActionKind,
  idempotencyKey: string,
  payload: unknown,
): ActionRequest {
  return {
    guildId: ctx.guildId,
    moduleId: 'moderation',
    kind,
    actorId: MODERATOR,
    idempotencyKey,
    dryRun: false,
    record: false,
    payload,
  };
}

function respondTo(event: ProtonEvent, ctx: Ctx) {
  const facts = readComponentInteraction(event) ?? readModalInteraction(event);
  if (!facts) throw new Error(`${event.type} is not a component or modal interaction`);

  return {
    guildId: ctx.guildId,
    moduleId: 'moderation',
    actorId: facts.userId,
    interaction: interactionRef(facts),
    applicationId: APPLICATION_ID,
  };
}

function capture<T>(): { seen: T[]; push(value: T): Promise<void> } {
  const seen: T[] = [];
  return {
    seen,
    push: async (value) => {
      seen.push(value);
    },
  };
}

describe('the fake REST upstream', () => {
  test('opens one DM channel per recipient and gives every send an id', async () => {
    const h = harness();
    const ctx = h.context();

    const opened = await ctx.executor.execute(
      action(ctx, 'create_dm', 'dm:open:member', { userId: MEMBER }),
    );
    const other = await ctx.executor.execute(
      action(ctx, 'create_dm', 'dm:open:reporter', { userId: REPORTER }),
    );
    expect(opened.body).toEqual({ id: DM_CHANNEL, type: 1 });
    expect((other.body as { id: string }).id).toBe(dmChannelFor(REPORTER));

    const first = await ctx.executor.execute(
      action(ctx, 'send', 'dm:send:member', { channelId: DM_CHANNEL, content: 'You were warned.' }),
    );
    const second = await ctx.executor.execute(
      action(ctx, 'send', 'dm:send:reporter', {
        channelId: dmChannelFor(REPORTER),
        content: 'Report filed.',
      }),
    );

    const ids = [first.body, second.body].map((body) => (body as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    expect(first.body).toMatchObject({ channel_id: DM_CHANNEL });

    expect(h.dms().map((dm) => [dm.userId, dm.message.content, dm.status])).toEqual([
      [MEMBER, 'You were warned.', 200],
      [REPORTER, 'Report filed.', 200],
    ]);
  });

  test('answers scripted routes with Discord error bodies, newest first, for as long as asked', async () => {
    const h = harness();
    const ctx = h.context({ botPermissions: BOT_PERMISSIONS | Permissions.ManageMessages });
    const send = (key: string) =>
      ctx.executor.execute(action(ctx, 'send', key, { channelId: DM_CHANNEL, content: 'hi' }));

    h.rest.respond(
      'POST /channels/',
      discordError(403, RESTJSONErrorCodes.CannotSendMessagesToThisUser, 'Cannot send messages'),
    );
    h.rest.respond(
      (call) => call.path === `/channels/${DM_CHANNEL}/messages`,
      discordError(403, RESTJSONErrorCodes.MissingAccess, 'Missing Access'),
      { times: 1 },
    );
    h.rest.respond(
      /^DELETE \/channels\/\d+\/messages\/\d+$/,
      discordError(404, RESTJSONErrorCodes.UnknownMessage, 'Unknown Message'),
    );

    expect((await send('a')).failure?.discordCode).toBe(RESTJSONErrorCodes.MissingAccess);
    expect((await send('b')).failure?.discordCode).toBe(
      RESTJSONErrorCodes.CannotSendMessagesToThisUser,
    );

    const deleted = await ctx.executor.execute(
      action(ctx, 'delete_message', 'proof', { channelId: CHANNEL, messageId: MESSAGE }),
    );
    expect(deleted.status).toBe('failed_api');
    expect(deleted.failure?.discordCode).toBe(RESTJSONErrorCodes.UnknownMessage);
    expect(h.deletes()).toEqual([{ channelId: CHANNEL, messageId: MESSAGE }]);
  });

  test('an assigned response still answers every call, ahead of the shaped defaults', async () => {
    const h = harness();
    const ctx = h.context();
    h.rest.response = { status: 500, body: {} };

    const opened = await ctx.executor.execute(
      action(ctx, 'create_dm', 'dm:open', { userId: MEMBER }),
    );

    expect(opened.status).toBe('failed_api');
    expect(h.dms()).toEqual([]);
  });

  test('a guild state override reaches the executor’s prechecks', async () => {
    const h = harness();
    const reports = '500000000000000002';
    const state = baseGuildState();
    state.channels.set(reports, {
      id: reports,
      parentId: null,
      overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: Permissions.SendMessages }],
    });

    const ctx = h.context({ guildState: state });
    const sent = await ctx.executor.execute(
      action(ctx, 'send', 'card', { channelId: reports, content: 'New report' }),
    );

    expect(sent.status).toBe('failed_precheck');
    expect(sent.failure?.humanReason).toContain(`<#${reports}>`);
    expect(h.sentIn(reports)).toEqual([]);
  });
});

describe('listen', () => {
  test('routes an event to every listener that declares its type', async () => {
    const h = harness();
    const reactions = capture<[ProtonEvent, string]>();
    const deletions = capture<ProtonEvent>();

    const listeners: EventListener<ModerationConfig>[] = [
      { types: ['reaction.added'], handler: (event, ctx) => reactions.push([event, ctx.guildId]) },
      {
        types: ['reaction.added', 'message.deleted'],
        handler: (event, ctx) => reactions.push([event, ctx.guildId]),
      },
      { types: ['message.deleted'], handler: (event) => deletions.push(event) },
    ];

    expect(await h.listen(reactionEvent(), listeners)).toBe(2);
    expect(await h.listen(messageDeletedEvent(), listeners)).toBe(2);

    const [event, guildId] = reactions.seen[0] ?? [];
    expect(guildId).toBe(GUILD);
    expect(event?.payload).toMatchObject({
      user_id: REPORTER,
      message_id: MESSAGE,
      message_author_id: MEMBER,
      emoji: { id: null, name: '🚩' },
      member: { user: { id: REPORTER, bot: false }, roles: [] },
    });
    expect(deletions.seen).toHaveLength(1);
  });

  test('refuses an action kind the manifest does not declare, as the worker would', async () => {
    const h = harness();
    const react: EventListener<ModerationConfig> = {
      types: ['message.deleted'],
      handler: async (_event, ctx) => {
        await ctx.executor.execute(
          action(ctx, 'add_reaction', 'react', {
            channelId: CHANNEL,
            messageId: MESSAGE,
            emoji: '✅',
          }),
        );
      },
    };

    await expect(h.listen(messageDeletedEvent(), [react])).rejects.toThrow("'add_reaction'");
    expect(h.keysUsed()).toEqual([]);

    await h.listen(messageDeletedEvent(), [react], { actionKinds: ['add_reaction'] });
    expect(h.keysUsed()).toEqual(['react']);
  });

  test('drops a DM interaction unless directInteractionGuild names the guild', async () => {
    const h = harness();
    const seen = capture<[ProtonEvent, string]>();
    const finish: EventListener<ModerationConfig> = {
      types: ['interaction.component'],
      handler: (event, ctx) => seen.push([event, ctx.guildId]),
    };

    const press = pressEvent(`proton:moderation:rfin:${GUILD}:Ab3dE5gH9k`, {
      guildId: null,
      userId: REPORTER,
    });
    const hook = (customId: { args: string[] }) => customId.args[0] ?? null;

    expect(await h.listen(press, [finish], { directInteractionGuild: () => null })).toBe(0);
    expect(await h.listen(press, [finish], { directInteractionGuild: hook })).toBe(1);
    expect(
      await h.listen(fixtureEvent('interactionCreateComponentDm'), [finish], {
        directInteractionGuild: hook,
      }),
    ).toBe(1);
    expect(await h.listen(press, [finish])).toBe(1);

    const [routed, guildId] = seen.seen[0] ?? [];
    expect(guildId).toBe(GUILD);
    expect(routed?.guildId).toBe(GUILD);

    const facts = routed ? readComponentInteraction(routed) : null;
    expect(facts?.guildId).toBeNull();
    expect(facts?.userId).toBe(REPORTER);
    expect(facts?.roleIds).toBeNull();
    expect(facts?.channelId).toBe(dmChannelFor(REPORTER));
    expect(seen.seen[1]?.[0].guildId).toBe(GUILD);
  });

  test('runs only config changes while the module is switched off', async () => {
    const h = harness();
    const any: EventListener<ModerationConfig> = {
      types: ['message.deleted', 'proton.config_changed'],
      handler: async () => undefined,
    };

    expect(await h.listen(messageDeletedEvent(), [any], { moduleEnabled: false })).toBe(0);
    expect(
      await h.listen(configChangedEvent({ enabledAfter: false }), [any], { moduleEnabled: false }),
    ).toBe(1);
  });
});

describe('interaction payloads', () => {
  test('a press carries the member, their permissions and the message it was on', () => {
    const event = pressEvent('proton:moderation:rclaim:Xk3P9aQ', {
      userId: MODERATOR,
      roleIds: [MOD_ROLE],
      permissions: Permissions.ModerateMembers,
      messageFlags: 64,
    });

    const facts = readComponentInteraction(event);
    expect(facts?.customId).toBe('proton:moderation:rclaim:Xk3P9aQ');
    expect(facts?.roleIds).toEqual([MOD_ROLE]);
    expect(facts?.messageId).toBe(MESSAGE);
    expect(facts?.messageFlags).toBe(64);
    expect(readMemberPermissions(event)).toBe(Permissions.ModerateMembers);
    expect(event.id).toBe(`interaction.component:${facts?.interactionId}`);
  });

  test('a modal submit reads like the recorded file-upload fixture', () => {
    const uploads = [
      rawAttachment({ ephemeral: true, filename: 'screenshot.png' }),
      rawAttachment({ ephemeral: true, filename: 'chat-log.txt', contentType: 'text/plain' }),
    ];
    const answers: ModalAnswers = {
      selects: { reason: ['spam'] },
      text: { comment: 'They posted this in three channels.' },
      files: { evidence: uploads },
      checks: { anonymous: true },
    };

    const mine = readModalInteraction(modalEvent('proton:moderation:rsub:Ab3dE5gH9k', answers));
    const recorded = readModalInteraction(fixtureEvent('interactionCreateModalFileUpload'));

    expect(Object.keys(mine?.fields ?? {})).toEqual(Object.keys(recorded?.fields ?? {}));
    expect(Object.keys(mine?.values ?? {}).sort()).toEqual(
      Object.keys(recorded?.values ?? {}).sort(),
    );
    expect(mine?.values.evidence).toEqual(uploads.map((upload) => String(upload.id)));
    expect(mine?.checks).toEqual({ anonymous: true });

    const attachments = [...(mine?.attachments.values() ?? [])];
    expect(attachments.map((attachment) => attachment.ephemeral)).toEqual([true, true]);
    expect(attachments.every((attachment) => typeof attachment.expiresAt === 'number')).toBe(true);
  });

  test('an autocomplete event focuses one option inside its subcommand', () => {
    const facts = readAutocompleteInteraction(
      autocompleteEvent(
        'ban',
        { name: 'reason', value: 'sp' },
        { subcommand: 'add', options: [userOption('user', MEMBER)] },
      ),
    );

    expect(facts?.commandName).toBe('ban');
    expect(facts?.subcommand).toBe('add');
    expect(facts?.focused).toEqual({ name: 'reason', type: OptionType.String, value: 'sp' });
    expect(facts?.options.map((option) => option.name)).toEqual(['user', 'reason']);
  });
});

describe('command', () => {
  test('runs a slash command as the worker builds it, with resolved data', async () => {
    const h = harness();
    const seen = capture<CommandContext<ModerationConfig>>();
    const probe: CommandDefinition<ModerationConfig> = {
      name: 'probe',
      description: 'probe',
      data: { name: 'probe', description: 'probe' },
      handler: (ctx) => seen.push(ctx),
    };

    const proof = rawAttachment({ filename: 'proof.png' });
    const event = slashEvent(
      'probe',
      [
        userOption('user', MEMBER),
        userOption('other', LEFT_MEMBER),
        { name: 'proof', type: OptionType.Attachment, value: String(proof.id) },
      ],
      {
        permissions: Permissions.BanMembers,
        roleIds: [MOD_ROLE],
        resolved: { attachments: { [String(proof.id)]: proof } },
      },
    );

    expect(await h.command(event, { commands: [probe] })).toBe(true);

    const ctx = seen.seen[0];
    expect(ctx?.actorPermissions).toBe(Permissions.BanMembers);
    expect(ctx?.actorRoleIds).toEqual([MOD_ROLE]);
    expect(ctx?.idempotencyKey).toBe(event.id);
    expect(ctx?.applicationId).toBe(APPLICATION_ID);
    expect([...(ctx?.resolved?.users.keys() ?? [])].sort()).toEqual([MEMBER, LEFT_MEMBER].sort());
    expect([...(ctx?.resolved?.members.keys() ?? [])]).toEqual([MEMBER]);
    expect(ctx?.options.getUserId('user')).toBe(MEMBER);
    expect(ctx?.options.getAttachment('proof')?.filename).toBe('proof.png');
  });

  test('runs user and message context menus with their target', async () => {
    const h = harness();
    const seen = capture<ContextMenuContext<ModerationConfig>>();
    const menu = (
      name: string,
      type: 'user' | 'message',
    ): ContextMenuDefinition<ModerationConfig> => ({
      name,
      type,
      description: name,
      data: {
        name,
        type: type === 'user' ? ApplicationCommandType.User : ApplicationCommandType.Message,
      },
      handler: (ctx) => seen.push(ctx),
    });
    const menus = [menu('Report user', 'user'), menu('Report message', 'message')];

    await h.command(userMenuEvent('Report user', MEMBER), { contextMenus: menus });
    await h.command(
      messageMenuEvent('Report message', {
        message: rawMessage({ content: 'spam', attachments: [rawAttachment()] }),
      }),
      { contextMenus: menus },
    );

    const [user, message] = seen.seen;
    expect(user?.commandType).toBe('user');
    expect(user?.targetId).toBe(MEMBER);
    expect(user?.resolved.members.get(MEMBER)?.roleIds).toBeDefined();

    expect(message?.commandType).toBe('message');
    expect(message?.targetId).toBe(MESSAGE);
    const reported = message?.resolved.messages.get(MESSAGE);
    expect(reported?.author?.id).toBe(MEMBER);
    expect(reported?.content).toBe('spam');
    expect(typeof reported?.attachments[0]?.expiresAt).toBe('number');
  });

  test('replays the recorded context-menu fixtures', async () => {
    const h = harness();
    const seen = capture<ContextMenuContext<ModerationConfig>>();
    const contextMenus: ContextMenuDefinition<ModerationConfig>[] = [
      {
        name: 'Report user',
        type: 'user',
        description: 'Report user',
        data: { name: 'Report user', type: ApplicationCommandType.User },
        handler: (ctx) => seen.push(ctx),
      },
      {
        name: 'Report message',
        type: 'message',
        description: 'Report message',
        data: { name: 'Report message', type: ApplicationCommandType.Message },
        handler: (ctx) => seen.push(ctx),
      },
    ];

    await h.command(fixtureEvent('interactionCreateUserCommand'), { contextMenus });
    await h.command(fixtureEvent('interactionCreateMessageCommand'), { contextMenus });

    const [user, message] = seen.seen;
    expect(user?.userId).toBe(MODERATOR);
    expect(user?.resolved.users.get(user.targetId)?.username).toBe('rulebreaker');

    const reported = message?.resolved.messages.get(message.targetId);
    expect(reported?.stickerNames).toEqual(['wave']);
    expect(reported?.attachments[0]?.expiresAt).toBe(0x6abf9cc0 * 1000);
  });

  test('does not run a command for a module the worker would treat as disabled', async () => {
    const h = harness();
    const seen = capture<CommandContext<ModerationConfig>>();
    const probe: CommandDefinition<ModerationConfig> = {
      name: 'probe',
      description: 'probe',
      data: { name: 'probe', description: 'probe' },
      handler: (ctx) => seen.push(ctx),
    };

    expect(await h.command(slashEvent('probe'), { commands: [probe], moduleEnabled: false })).toBe(
      false,
    );
    expect(
      await h.command(slashEvent('probe'), { commands: [probe], config: { enabled: false } }),
    ).toBe(false);
    expect(seen.seen).toEqual([]);
  });

  test('run() passes the invoker overrides through to the command context', async () => {
    const h = harness();
    const seen = capture<CommandContext<ModerationConfig>>();
    const probe: CommandDefinition<ModerationConfig> = {
      name: 'probe',
      description: 'probe',
      data: { name: 'probe', description: 'probe' },
      handler: (ctx) => seen.push(ctx),
    };

    await h.run('probe', [], {
      commands: [probe],
      userId: REPORTER,
      actorPermissions: Permissions.KickMembers,
    });

    expect(seen.seen[0]?.userId).toBe(REPORTER);
    expect(seen.seen[0]?.actorRoleIds).toEqual([]);
    expect(seen.seen[0]?.actorPermissions).toBe(Permissions.KickMembers);
  });
});

describe('jobs, events and the clock', () => {
  test('keeps a pending job unless told to replace it, and runs it once it is due', async () => {
    const h = harness();
    const ctx = h.context();
    const ran = capture<unknown>();
    const handlers = { 'moderation.timeout': (data: unknown) => ran.push(data) };
    const at = new Date(h.now() + 60_000);

    expect(await ctx.schedule?.('moderation.timeout', at, MEMBER, { n: 1 })).toEqual({
      scheduled: true,
      replaced: false,
    });
    expect(await ctx.schedule?.('moderation.timeout', at, MEMBER, { n: 2 })).toEqual({
      scheduled: false,
      replaced: false,
    });
    expect(
      await ctx.schedule?.('moderation.timeout', at, MEMBER, { n: 3 }, { replace: true }),
    ).toEqual({ scheduled: true, replaced: true });
    expect(h.pendingJobs().map((job) => job.data)).toEqual([{ n: 3 }]);

    expect(await h.runDue({ handlers })).toBe(0);
    h.advance(60_000);
    expect(await h.runDue({ handlers })).toBe(1);
    expect(ran.seen).toEqual([{ n: 3 }]);
    expect(h.pendingJobs()).toEqual([]);

    await ctx.cancel?.('moderation.timeout', MEMBER);
    expect(h.cancelled).toEqual([{ jobId: 'moderation.timeout', naturalKey: MEMBER }]);
  });

  test('refuses a schedule and an event the manifest does not declare', async () => {
    const h = harness();
    const ctx = h.context();

    await expect(ctx.schedule?.('moderation.nope', new Date(), 'k')).rejects.toBeInstanceOf(
      UndeclaredScheduleError,
    );
    await expect(ctx.publish?.('tickets.opened', 'k', {})).rejects.toThrow("'tickets.opened'");

    await ctx.publish?.('moderation.report_submitted', 'Xk3P9aQ', { reportId: 'Xk3P9aQ' });
    expect(h.publishedEvents.map((event) => [event.id, event.occurredAt])).toEqual([
      [`moderation.report_submitted:${GUILD}:Xk3P9aQ`, h.now()],
    ]);
  });

  test('the executor’s dedupe window follows the injected clock', async () => {
    const h = harness({ now: Date.UTC(2026, 8, 18, 12) });
    const ctx = h.context();
    const send = () =>
      ctx.executor.execute(action(ctx, 'send', 'once', { channelId: CHANNEL, content: 'hi' }));

    expect((await send()).status).toBe('executed');
    expect((await send()).status).toBe('skipped_duplicate');

    h.advance(24 * 60 * 60 * 1000 + 1);
    expect((await send()).status).toBe('executed');
    expect(h.keysUsed()).toEqual(['once', 'once', 'once']);
  });
});

describe('answer readers', () => {
  test('separate replies, updates, modals, deferrals, follow-ups, edits and deletes', async () => {
    const h = harness();
    const flow: EventListener<ModerationConfig> = {
      types: ['interaction.component', 'interaction.modal'],
      handler: async (event, ctx) => {
        const to = respondTo(event, ctx);
        const facts = readComponentInteraction(event);

        if (facts?.customId.endsWith(':open')) {
          await ctx.executor.execute(
            openModal(to, {
              customId: 'proton:moderation:rdis:Xk3P9aQ',
              title: 'Dismiss report',
              components: [{ type: 18, label: 'Note', component: { type: 4, custom_id: 'note' } }],
            }),
          );
          return;
        }

        if (facts) {
          await ctx.executor.execute(replyEphemeral(to, successStatus('Claimed.')));
          await ctx.executor.execute(updateMessage(to, 'Working on it…'));
          return;
        }

        await ctx.executor.execute(deferEphemeral(to));
        await ctx.executor.execute(followUp(to, errorStatus('That report is already closed.')));
        await ctx.executor.execute(
          action(ctx, 'edit_message', 'card:v2', {
            channelId: CHANNEL,
            messageId: MESSAGE,
            content: 'Dismissed',
          }),
        );
        await ctx.executor.execute(
          action(ctx, 'delete_message', 'card:delete', { channelId: CHANNEL, messageId: MESSAGE }),
        );
      },
    };

    await h.listen(pressEvent('proton:moderation:rclaim:Xk3P9aQ'), [flow]);
    await h.listen(pressEvent('proton:moderation:rdismiss:open'), [flow]);
    await h.listen(
      modalEvent('proton:moderation:rdis:Xk3P9aQ', { text: { note: 'dupe' } }),
      [flow],
      { botPermissions: BOT_PERMISSIONS | Permissions.ManageMessages },
    );

    expect(h.callbackTypes()).toEqual([4, 7, 9, 5]);
    expect(h.replies().map((reply) => h.statusOf(reply))).toEqual(['success', 'neutral']);
    expect(h.modalsOpened()[0]).toMatchObject({ custom_id: 'proton:moderation:rdis:Xk3P9aQ' });
    expect(h.followUps().map((message) => h.statusOf(message))).toEqual(['error']);
    expect(h.edits()).toEqual([
      {
        channelId: CHANNEL,
        messageId: MESSAGE,
        message: expect.objectContaining({ content: 'Dismissed' }),
      },
    ]);
    expect(h.deletes()).toEqual([{ channelId: CHANNEL, messageId: MESSAGE }]);
    expect(h.sentIn(CHANNEL)).toEqual([]);
  });
});
