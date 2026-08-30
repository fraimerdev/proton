import {
  type CommandContext,
  type CommandDefinition,
  formatDuration,
  Permissions,
  snowflakeSchema,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import { isRefusal, perform, readDuration } from '../perform.ts';

type Command = CommandDefinition<ModerationConfig>;

const SECONDS_PER_DAY = 86_400;

const REASON_MAX = 512;

export const banCommand: Command = {
  name: 'ban',
  description: 'Ban a member, or lift a ban.',

  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member, or lift a ban.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.BanMembers)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Ban a member from this server.')
        .addUserOption((option) =>
          option.setName('user').setDescription('The member to ban.').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('Temporary ban length, e.g. 12h or 7d. Omit to ban permanently.'),
        )
        .addIntegerOption((option) =>
          option
            .setName('delete_message_days')
            .setDescription('Days of their recent messages to delete, 0-7.')
            .setMinValue(0)
            .setMaxValue(7),
        )
        .addStringOption((option) =>
          option
            .setName('reason')
            .setDescription('Written to the Discord audit log and to the case.')
            .setMaxLength(REASON_MAX),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Lift a ban on a user.')
        .addStringOption((option) =>
          option
            .setName('user_id')
            .setDescription(
              'Id of the banned user. They are not in the server to pick from a list.',
            )
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('reason')
            .setDescription('Written to the Discord audit log and to the case.')
            .setMaxLength(REASON_MAX),
        ),
    )
    .toJSON(),

  async handler(ctx) {
    switch (ctx.options.getSubcommand()) {
      case 'add':
        return addBan(ctx);
      case 'remove':
        return removeBan(ctx);
      default:
        return perform(ctx, {
          refusal: 'Use /ban add to ban someone, or /ban remove to lift a ban.',
        });
    }
  },
};

async function addBan(ctx: CommandContext<ModerationConfig>): Promise<void> {
  const userId = ctx.options.getUserId('user');
  if (!userId) return perform(ctx, { refusal: 'I need a user to ban.' });

  const reason = ctx.options.getString('reason');
  const days = ctx.options.getInteger('delete_message_days') ?? ctx.config.defaultBanDeleteDays;
  const rawDuration = ctx.options.getString('duration');

  if (!rawDuration) {
    return perform(ctx, {
      kind: 'ban',
      targetId: userId,
      payload: { userId, deleteMessageSeconds: days * SECONDS_PER_DAY },
      ...(reason ? { reason } : {}),
      success: `Banned <@${userId}>.`,
    });
  }

  const duration = readDuration(rawDuration, 'A temporary ban');
  if (isRefusal(duration)) return perform(ctx, duration);

  return perform(ctx, {
    kind: 'ban',
    targetId: userId,
    payload: { userId, deleteMessageSeconds: days * SECONDS_PER_DAY },
    ...(reason ? { reason } : {}),
    expiresAt: new Date(Date.now() + duration.ms),
    success: `Banned <@${userId}> for ${formatDuration(duration.ms)} — it lifts automatically.`,
    successWithoutReversal: `Banned <@${userId}>.`,
  });
}

async function removeBan(ctx: CommandContext<ModerationConfig>): Promise<void> {
  const userId = ctx.options.getString('user_id')?.trim() ?? '';
  const reason = ctx.options.getString('reason');

  if (!snowflakeSchema.safeParse(userId).success) {
    return perform(ctx, {
      refusal:
        `'${userId}' is not a Discord user id. Turn on Developer Mode in Discord, then ` +
        'right-click the user in Server Settings, Bans and choose Copy User ID.',
    });
  }

  return perform(ctx, {
    kind: 'unban',
    targetId: userId,
    payload: { userId },
    ...(reason ? { reason } : {}),
    success: `Unbanned <@${userId}>.`,
  });
}

export const warnCommand: Command = {
  name: 'warn',
  description: 'Record a warning against a member.',

  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Record a warning against a member.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ModerateMembers)
    .addUserOption((option) =>
      option.setName('user').setDescription('The member to warn.').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Shown in the case and to the member.')
        .setMaxLength(REASON_MAX),
    )
    .toJSON(),

  async handler(ctx) {
    const userId = ctx.options.getUserId('user');
    if (!userId) return perform(ctx, { refusal: 'I need a user to warn.' });

    const reason = ctx.options.getString('reason');

    await perform(ctx, {
      kind: 'warn',
      targetId: userId,
      payload: { userId, ...(reason ? { note: reason } : {}) },
      ...(reason ? { reason } : {}),
      success: `Warned <@${userId}>.`,

      async onRecorded() {
        await ctx.publish?.('moderation.warned', `${ctx.idempotencyKey}:warn`, {
          userId,
          channelId: ctx.channelId,
        });
      },
    });
  },
};

export const kickCommand: Command = {
  name: 'kick',
  description: 'Remove a member from this server.',

  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a member from this server.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.KickMembers)
    .addUserOption((option) =>
      option.setName('user').setDescription('The member to kick.').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Written to the Discord audit log and to the case.')
        .setMaxLength(REASON_MAX),
    )
    .toJSON(),

  async handler(ctx) {
    const userId = ctx.options.getUserId('user');
    if (!userId) return perform(ctx, { refusal: 'I need a member to kick.' });

    const reason = ctx.options.getString('reason');

    return perform(ctx, {
      kind: 'kick',
      targetId: userId,
      payload: { userId },
      ...(reason ? { reason } : {}),
      success: `Kicked <@${userId}>. Nothing stops them rejoining with a new invite.`,
    });
  },
};

export const timeoutCommand: Command = {
  name: 'timeout',
  description: 'Time a member out for a while.',

  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Time a member out for a while.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ModerateMembers)
    .addUserOption((option) =>
      option.setName('user').setDescription('The member to time out.').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('How long, e.g. 30m or 7d. Discord caps timeouts at 28 days.'),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Written to the Discord audit log and to the case.')
        .setMaxLength(REASON_MAX),
    )
    .toJSON(),

  async handler(ctx) {
    const userId = ctx.options.getUserId('user');
    if (!userId) return perform(ctx, { refusal: 'I need a member to time out.' });

    const raw = ctx.options.getString('duration') ?? ctx.config.defaultTimeoutDuration;
    const duration = readDuration(raw, 'A timeout');
    if (isRefusal(duration)) return perform(ctx, duration);

    const reason = ctx.options.getString('reason');

    return perform(ctx, {
      kind: 'timeout',
      targetId: userId,
      payload: { userId, until: new Date(Date.now() + duration.ms) },
      ...(reason ? { reason } : {}),
      success: `Timed out <@${userId}> for ${formatDuration(duration.ms)}.`,
    });
  },
};

export const untimeoutCommand: Command = {
  name: 'untimeout',
  description: 'End a timeout early.',

  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('End a timeout early.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ModerateMembers)
    .addUserOption((option) =>
      option.setName('user').setDescription('The member to release.').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Written to the Discord audit log and to the case.')
        .setMaxLength(REASON_MAX),
    )
    .toJSON(),

  async handler(ctx) {
    const userId = ctx.options.getUserId('user');
    if (!userId) return perform(ctx, { refusal: 'I need a member to release.' });

    const reason = ctx.options.getString('reason');

    return perform(ctx, {
      kind: 'untimeout',
      targetId: userId,
      payload: { userId },
      ...(reason ? { reason } : {}),
      success: `<@${userId}> can talk again.`,
    });
  },
};

export const memberCommands: Command[] = [
  banCommand,
  kickCommand,
  timeoutCommand,
  untimeoutCommand,
  warnCommand,
];
