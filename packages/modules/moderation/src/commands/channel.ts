import {
  type CommandContext,
  type CommandDefinition,
  formatDuration,
  MAX_SLOWMODE_SECONDS,
  Permissions,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import { everyoneRoleId, isRefusal, perform, readDuration, readSpan } from '../perform.ts';

type Command = CommandDefinition<ModerationConfig>;

export const slowmodeCommand: Command = {
  name: 'slowmode',
  description: 'Set how often members may post in this channel.',

  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set how often members may post in this channel.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ManageChannels)
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('The wait between messages, e.g. 30s or 5m. Use 0s to switch slowmode off.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('The reason for this action.').setMaxLength(512),
    )
    .toJSON(),

  async handler(ctx) {
    const raw = ctx.options.getString('duration');
    if (!raw) return perform(ctx, { refusal: 'I need a slowmode duration, for example 30s.' });

    const span = readSpan(raw);
    if (isRefusal(span)) return perform(ctx, span);

    const seconds = span.ms / 1000;
    if (seconds > MAX_SLOWMODE_SECONDS) {
      return perform(ctx, {
        refusal: `You cannot set the slowmode to more than ${formatDuration(MAX_SLOWMODE_SECONDS * 1000)}`,
      });
    }

    const reason = ctx.options.getString('reason');

    return perform(ctx, {
      kind: 'slowmode',
      payload: { channelId: ctx.channelId, seconds },
      ...(reason ? { reason } : {}),
      success:
        seconds === 0
          ? 'Slowmode is off in this channel.'
          : `Members must now wait ${formatDuration(span.ms)} between messages in this channel.`,
    });
  },
};

export const lockdownCommand: Command = {
  name: 'lockdown',
  description: 'Lock this channel, or reopen it.',

  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Lock this channel, or reopen it.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ManageChannels)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Stop everyone posting in this channel.')
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('Reopen automatically after this long, e.g. 30m. Omit to stay locked.'),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('The reason for this action.').setMaxLength(512),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Let everyone post in this channel again.')
        .addStringOption((option) =>
          option.setName('reason').setDescription('The reason for this action.').setMaxLength(512),
        ),
    )
    .toJSON(),

  async handler(ctx) {
    switch (ctx.options.getSubcommand()) {
      case 'add':
        return addLockdown(ctx);
      case 'remove':
        return removeLockdown(ctx);
      default:
        return perform(ctx, {
          refusal: 'Use /lockdown add to lock this channel, or /lockdown remove to reopen it.',
        });
    }
  },
};

async function addLockdown(ctx: CommandContext<ModerationConfig>): Promise<void> {
  const reason = ctx.options.getString('reason');
  const rawDuration = ctx.options.getString('duration');

  const payload = { channelId: ctx.channelId, roleId: everyoneRoleId(ctx.guildId) };

  if (!rawDuration) {
    return perform(ctx, {
      kind: 'lockdown',
      payload,
      ...(reason ? { reason } : {}),
      success: 'Locked this channel. Run /lockdown remove when it should reopen.',
    });
  }

  const duration = readDuration(rawDuration, 'A lockdown');
  if (isRefusal(duration)) return perform(ctx, duration);

  return perform(ctx, {
    kind: 'lockdown',
    payload,
    ...(reason ? { reason } : {}),
    expiresAt: new Date(Date.now() + duration.ms),
    success: `Locked this channel. It reopens automatically in ${formatDuration(duration.ms)}.`,
    successWithoutReversal: 'Locked this channel.',
  });
}

async function removeLockdown(ctx: CommandContext<ModerationConfig>): Promise<void> {
  const reason = ctx.options.getString('reason');

  return perform(ctx, {
    kind: 'unlock',
    payload: { channelId: ctx.channelId, roleId: everyoneRoleId(ctx.guildId) },
    ...(reason ? { reason } : {}),
    success: 'Unlocked this channel.',
  });
}

export const channelCommands: Command[] = [slowmodeCommand, lockdownCommand];
