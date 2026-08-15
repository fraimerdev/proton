import { type CommandDefinition, formatDuration, Permissions, snowflakeSchema } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import { isRefusal, perform, readDuration } from '../perform.ts';

type Command = CommandDefinition<ModerationConfig>;

const SECONDS_PER_DAY = 86_400;

/**
 * 512 characters because that is the ceiling `actionRequestSchema` enforces.
 * Letting Discord accept more would mean the executor rejecting an otherwise
 * valid ban over a field that only annotates it.
 */
const REASON_MAX = 512;

/**
 * `default_member_permissions` hides a command from members who could not use
 * it. That is presentation, not authorisation: the executor still runs every I8
 * precheck, because Discord's own gate can be overridden per guild.
 */
export const banCommand: Command = {
  name: 'ban',
  description: 'Ban a member from this server.',

  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from this server.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.BanMembers)
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
    )
    .toJSON(),

  async handler(ctx) {
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

    // `expiresAt` is what makes this temporary: the executor schedules the
    // unban, and refuses the whole request up front if it cannot (I1/P3).
    return perform(ctx, {
      kind: 'ban',
      targetId: userId,
      payload: { userId, deleteMessageSeconds: days * SECONDS_PER_DAY },
      ...(reason ? { reason } : {}),
      expiresAt: new Date(Date.now() + duration.ms),
      success: `Banned <@${userId}> for ${formatDuration(duration.ms)} — it lifts automatically.`,
    });
  },
};

export const unbanCommand: Command = {
  name: 'unban',
  description: 'Lift a ban on a user.',

  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Lift a ban on a user.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.BanMembers)
    .addStringOption((option) =>
      option
        .setName('user_id')
        .setDescription('Id of the banned user. They are not in the server to pick from a list.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Written to the Discord audit log and to the case.')
        .setMaxLength(REASON_MAX),
    )
    .toJSON(),

  async handler(ctx) {
    const userId = ctx.options.getString('user_id')?.trim() ?? '';
    const reason = ctx.options.getString('reason');

    // A banned user is not a member, so Discord cannot offer them as a USER
    // option. The id arrives as free text; checking it here turns a typo into an
    // instruction instead of a 404 from Discord.
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
  description: 'Silence a member for a while.',

  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Silence a member for a while.')
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

    // Deliberately no `expiresAt`. Discord lifts a timeout itself at
    // `communication_disabled_until`, so a scheduled reversal would queue an
    // untimeout for a member who is already free.
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

/** The five commands that act on a member, and so face the hierarchy prechecks. */
export const memberCommands: Command[] = [
  banCommand,
  unbanCommand,
  kickCommand,
  timeoutCommand,
  untimeoutCommand,
];
