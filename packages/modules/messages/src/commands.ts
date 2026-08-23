import {
  type CommandContext,
  type CommandDefinition,
  type InteractionRef,
  Permissions,
  type RespondTo,
  toDiscordMessage,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { ChannelType, InteractionContextType, InteractionType } from 'discord-api-types/v10';
import { customIdFor } from './component-id.ts';
import { buildComposerModal } from './compose.ts';
import {
  findTemplate,
  type MessagesConfig,
  MODULE_ID,
  renderNames,
  type SavedMessage,
  TEMPLATE_LIST_SHOWN,
  TEMPLATE_NAME_MAX,
} from './config.ts';
import { bindFollowUp, describeUnbound, type MessagesDeps } from './deps.ts';
import {
  deferEphemeral,
  followUp,
  openModal,
  postMessage,
  replyEphemeral,
  respondTo,
  succeeded,
} from './perform.ts';

type Command = CommandDefinition<MessagesConfig>;

// No private threads: nothing here can work out whether the member may read the channel they
// name, so the option must not offer the one channel type whose whole purpose is to be unreadable.
const POSTABLE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.AnnouncementThread,
] as const;

const MESSAGE_DESCRIPTION =
  'Post one of this server’s saved messages, or compose one now. Needs Manage Messages.';

const CROSS_CHANNEL_GATE =
  ' `/message` is limited to members with Manage Messages, and posting into a channel other than ' +
  'the one you are in also needs Proton to be able to see and post there.';

const NOT_WIRED =
  "I can't post that: this Proton deployment isn't fully set up, so I have no way to tell you " +
  'afterwards whether it worked. Nothing was posted. A server admin should check the Proton ' +
  'logs — the exact missing piece is named there.';

function interactionOf(ctx: CommandContext<MessagesConfig>): InteractionRef {
  return {
    id: ctx.interaction.id,
    token: ctx.interaction.token,
    type: InteractionType.ApplicationCommand,
  };
}

function replyTo(ctx: CommandContext<MessagesConfig>): RespondTo {
  return respondTo(ctx, interactionOf(ctx), ctx.userId, ctx.idempotencyKey);
}

export function describeUnknown(saved: readonly SavedMessage[], name: string): string {
  if (saved.length === 0) {
    return (
      `This server has no saved messages yet, so there is nothing called “${name}” to post. An ` +
      'admin can save one on the Proton dashboard, or you can compose a one-off right now with ' +
      '`/message send`.'
    );
  }

  return (
    `There is no saved message called “${name}” in this server. These are saved: ` +
    `${renderNames(saved.map((message) => message.name))}.`
  );
}

export function describeList(saved: readonly SavedMessage[]): string {
  if (saved.length === 0) {
    return (
      'This server has no saved messages yet. An admin saves them on the Proton dashboard, and ' +
      '`/message send` composes a one-off without saving it.'
    );
  }

  return (
    `**Saved messages** — ${saved.length} in this server\n` +
    renderNames(
      saved.map((message) => message.name),
      TEMPLATE_LIST_SHOWN,
    )
  );
}

function messageBuilder(): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName('message')
    .setDescription(MESSAGE_DESCRIPTION)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ManageMessages);

  builder.addSubcommand((sub) =>
    sub
      .setName('post')
      .setDescription('Post a saved message.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Which saved message to post.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(TEMPLATE_NAME_MAX),
      )
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Where to post it. Defaults to this channel.')
          .addChannelTypes(...POSTABLE_CHANNELS),
      ),
  );

  builder.addSubcommand((sub) =>
    sub.setName('list').setDescription('List this server’s saved messages.'),
  );

  builder.addSubcommand((sub) =>
    sub.setName('send').setDescription('Compose a one-off message and post it here.'),
  );

  return builder;
}

async function post(ctx: CommandContext<MessagesConfig>, deps: MessagesDeps): Promise<void> {
  const to = replyTo(ctx);

  const name = ctx.options.getString('name');
  if (name === null || name.trim().length === 0) {
    await replyEphemeral(ctx, to, 'That command needs the name of a saved message.');
    return;
  }

  const saved = findTemplate(ctx.config.templates, name);
  if (!saved) {
    await replyEphemeral(ctx, to, describeUnknown(ctx.config.templates, name.trim()));
    return;
  }

  const channelId = ctx.options.getChannelId('channel') ?? ctx.channelId;

  const bound = bindFollowUp(deps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound(`the saved message '${saved.name}' was not posted`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, to, NOT_WIRED);
    return;
  }

  await deferEphemeral(ctx, to);

  const result = await postMessage(ctx, {
    channelId,
    body: toDiscordMessage(saved, { customIdFor: customIdFor(saved.name) }),
    actorId: ctx.userId,
    idempotencyRoot: ctx.idempotencyKey,
  });

  await followUp(
    ctx,
    to,
    bound.deps.applicationId,
    succeeded(result)
      ? `Posted **${saved.name}** in <#${channelId}>.`
      : `I could not post **${saved.name}** in <#${channelId}>. ${
          result.failure?.humanReason ?? 'Discord refused it and gave no reason.'
        }${channelId === ctx.channelId ? '' : CROSS_CHANNEL_GATE}`,
  );
}

async function list(ctx: CommandContext<MessagesConfig>): Promise<void> {
  await replyEphemeral(ctx, replyTo(ctx), describeList(ctx.config.templates));
}

async function send(ctx: CommandContext<MessagesConfig>): Promise<void> {
  const to = replyTo(ctx);
  const composer = buildComposerModal();

  if (!composer.ok) {
    ctx.logger.error(`messages could not build its composer modal: ${composer.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await replyEphemeral(
      ctx,
      to,
      'I could not open the message composer. Nothing was posted, and the Proton logs say why.',
    );
    return;
  }

  await openModal(ctx, to, composer.modal);
}

export function messageCommand(deps: MessagesDeps): Command {
  return {
    name: 'message',
    description: MESSAGE_DESCRIPTION,

    data: messageBuilder().toJSON(),

    async handler(ctx) {
      switch (ctx.options.getSubcommand()) {
        case 'post':
          return post(ctx, deps);
        case 'list':
          return list(ctx);
        case 'send':
          return send(ctx);
        default:
          await replyEphemeral(ctx, replyTo(ctx), 'That subcommand is not one I know.');
      }
    },
  };
}

export function messagesCommands(deps: MessagesDeps): Command[] {
  return [messageCommand(deps)];
}
