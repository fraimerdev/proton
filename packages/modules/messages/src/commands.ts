import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  type InteractionRef,
  labelOf,
  type ModuleContext,
  Permissions,
  type RespondTo,
  successStatus,
  toDiscordMessage,
} from '@proton/core';
import { type MessageRender, usedKeys } from '@proton/core/placeholders';
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
import {
  bindFollowUp,
  describeUnbound,
  logReadFailure,
  type MessagesDeps,
  readPlaceholderSources,
} from './deps.ts';
import {
  deferEphemeral,
  followUp,
  openModal,
  postMessage,
  replyEphemeral,
  respondTo,
  succeeded,
} from './perform.ts';
import { MESSAGES_POST_SURFACE, messageTexts, renderSavedMessage } from './placeholders.ts';

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

const MESSAGE_DESCRIPTION = 'Post a template or compose a new message. Needs Manage Messages.';

type Labels = Pick<ModuleContext, 'commandLabel'>;

function crossChannelGate(labels: Labels): string {
  return (
    ` \`${labelOf(labels, 'message')}\` is limited to members with Manage Messages, and to post ` +
    'in another channel I need View Channel and Send Messages there.'
  );
}

const NOT_WIRED =
  'I can’t post that right now, so nothing was posted. This is a fault on my side, not a ' +
  'setting in this server.';

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

export function describeUnknown(
  saved: readonly SavedMessage[],
  name: string,
  labels: Labels = {},
): string {
  if (saved.length === 0) {
    return (
      `This server has no templates yet, so there’s nothing called “${name}” to post. An admin ` +
      'can create one on the Proton dashboard, or you can compose a one-off message now with ' +
      `\`${labelOf(labels, 'message', 'send')}\`.`
    );
  }

  return (
    `Couldn’t find a template called “${name}”. Templates in this server: ` +
    `${renderNames(saved.map((message) => message.name))}.`
  );
}

export function describeList(saved: readonly SavedMessage[], labels: Labels = {}): string {
  if (saved.length === 0) {
    return (
      'This server has no templates yet. An admin can create them on the Proton dashboard, and ' +
      `\`${labelOf(labels, 'message', 'send')}\` composes a one-off message without saving it.`
    );
  }

  return (
    `**${saved.length} ${saved.length === 1 ? 'template' : 'templates'} in this server**\n` +
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
      .setDescription('Post a template.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('The template to post.')
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
    sub.setName('list').setDescription('List this server’s templates.'),
  );

  builder.addSubcommand((sub) =>
    sub.setName('send').setDescription('Compose a one-off embed and post it in this channel.'),
  );

  return builder;
}

async function renderForPost(
  ctx: CommandContext<MessagesConfig>,
  deps: MessagesDeps,
  saved: SavedMessage,
  channelId: string,
): Promise<MessageRender<SavedMessage>> {
  const now = deps.placeholders?.now() ?? Date.now();
  const sources = await readPlaceholderSources(
    deps,
    ctx.guildId,
    channelId,
    usedKeys(MESSAGES_POST_SURFACE, messageTexts(saved), { allowedOnly: true }),
    logReadFailure(ctx.logger, `the saved message '${saved.name}'`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      template: saved.name,
    }),
  );

  return renderSavedMessage(
    saved,
    MESSAGES_POST_SURFACE,
    {
      ...sources,
      actor: {
        user: {
          id: ctx.userId,
          username: null,
          globalName: ctx.actorDisplayName ?? null,
          avatarHash: null,
        },
        member: { nick: ctx.actorNick },
      },
    },
    now,
  );
}

async function post(ctx: CommandContext<MessagesConfig>, deps: MessagesDeps): Promise<void> {
  const to = replyTo(ctx);

  const name = ctx.options.getString('name');
  if (name === null || name.trim().length === 0) {
    await replyEphemeral(ctx, to, errorStatus('Choose a template to post.'));
    return;
  }

  const saved = findTemplate(ctx.config.templates, name);
  if (!saved) {
    await replyEphemeral(
      ctx,
      to,
      errorStatus(describeUnknown(ctx.config.templates, name.trim(), ctx)),
    );
    return;
  }

  const channelId = ctx.options.getChannelId('channel') ?? ctx.channelId;

  const bound = bindFollowUp(deps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound(`the saved message '${saved.name}' was not posted`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, to, errorStatus(NOT_WIRED));
    return;
  }

  await deferEphemeral(ctx, to);

  const rendered =
    saved.placeholders === true
      ? await renderForPost(ctx, deps, saved, channelId)
      : { ok: true as const, message: saved };

  if (!rendered.ok) {
    ctx.logger.warn(`the saved message '${saved.name}' was not posted: ${rendered.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      template: saved.name,
    });
    await followUp(
      ctx,
      to,
      bound.deps.applicationId,
      errorStatus(
        `Couldn’t post **${saved.name}** in <#${channelId}> because ${rendered.humanReason} ` +
          'Nothing was posted. An admin can fix it on the Proton dashboard under Messages → Templates.',
      ),
    );
    return;
  }

  const result = await postMessage(ctx, {
    channelId,
    body: toDiscordMessage(rendered.message, { customIdFor: customIdFor(saved.name) }),
    actorId: ctx.userId,
    idempotencyRoot: ctx.idempotencyKey,
  });

  await followUp(
    ctx,
    to,
    bound.deps.applicationId,
    succeeded(result)
      ? successStatus(`Posted **${saved.name}** in <#${channelId}>.`)
      : errorStatus(
          `Couldn’t post **${saved.name}** in <#${channelId}>. ${
            result.failure?.humanReason ?? 'Discord refused it and gave no reason.'
          }${channelId === ctx.channelId ? '' : crossChannelGate(ctx)}`,
        ),
  );
}

async function list(ctx: CommandContext<MessagesConfig>): Promise<void> {
  // A listing, not a status, so it stays plain text — but the names in it are admin-authored free
  // text, and one saved as @everyone would ping the server on its way back out.
  await replyEphemeral(ctx, replyTo(ctx), {
    content: describeList(ctx.config.templates, ctx),
    allowedMentions: { parse: [] },
  });
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
      errorStatus(
        'Couldn’t open the composer, so nothing was posted. This is a fault on my side, not a ' +
          'setting in this server.',
      ),
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
          await replyEphemeral(
            ctx,
            replyTo(ctx),
            errorStatus(`I don’t know that \`${labelOf(ctx, 'message')}\` subcommand.`),
          );
      }
    },
  };
}

export function messagesCommands(deps: MessagesDeps): Command[] {
  return [messageCommand(deps)];
}
