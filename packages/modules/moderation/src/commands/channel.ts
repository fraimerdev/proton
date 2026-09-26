import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  formatDuration,
  labelOf,
  MAX_SLOWMODE_SECONDS,
  Permissions,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import {
  everyoneRoleId,
  isRefusal,
  moderationReply,
  type PlanResult,
  perform,
  readDuration,
  readSpan,
  refusalOf,
  reply,
} from '../perform.ts';
import { acknowledge } from './answer.ts';

type Command = CommandDefinition<ModerationConfig>;
type Ctx = CommandContext<ModerationConfig>;

async function act(ctx: Ctx, deps: ModerationDeps, plan: PlanResult): Promise<void> {
  const refusal = refusalOf(ctx.config, plan);
  if (refusal !== null) return reply(ctx, errorStatus(refusal));

  return perform(ctx, plan, await acknowledge(ctx, deps));
}

export function slowmodeCommand(deps: ModerationDeps): Command {
  return {
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
          .setDescription('The wait between messages, like 30s or 5m. Use 0s to turn slowmode off.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('The reason for this action.').setMaxLength(512),
      )
      .toJSON(),

    reply: moderationReply(['']),

    async handler(ctx) {
      const raw = ctx.options.getString('duration');
      if (!raw) return act(ctx, deps, { refusal: 'I need a slowmode duration, for example 30s.' });

      const span = readSpan(raw);
      if (isRefusal(span)) return act(ctx, deps, span);

      const seconds = span.ms / 1000;
      if (seconds > MAX_SLOWMODE_SECONDS) {
        return act(ctx, deps, {
          refusal:
            `Discord caps slowmode at ${formatDuration(MAX_SLOWMODE_SECONDS * 1000)}, so I can't ` +
            `set this channel's wait to ${formatDuration(span.ms)}.`,
        });
      }

      const reason = ctx.options.getString('reason');

      return act(ctx, deps, {
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
}

export function lockdownCommand(deps: ModerationDeps): Command {
  return {
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
          .setDescription('Stop everyone from posting in this channel.')
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription(
                'Reopen automatically after this long, like 30m. Leave empty to stay locked.',
              ),
          )
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription('The reason for this action.')
              .setMaxLength(512),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Let everyone post in this channel again.')
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription('The reason for this action.')
              .setMaxLength(512),
          ),
      )
      .toJSON(),

    reply: moderationReply(['add', 'remove']),

    async handler(ctx) {
      switch (ctx.options.getSubcommand()) {
        case 'add':
          return addLockdown(ctx, deps);
        case 'remove':
          return removeLockdown(ctx, deps);
        default:
          return act(ctx, deps, {
            refusal:
              `Use ${labelOf(ctx, 'lockdown', 'add')} to lock this channel, or ` +
              `${labelOf(ctx, 'lockdown', 'remove')} to reopen it.`,
          });
      }
    },
  };
}

async function addLockdown(ctx: Ctx, deps: ModerationDeps): Promise<void> {
  const reason = ctx.options.getString('reason');
  const rawDuration = ctx.options.getString('duration');

  const payload = { channelId: ctx.channelId, roleId: everyoneRoleId(ctx.guildId) };

  if (!rawDuration) {
    return act(ctx, deps, {
      kind: 'lockdown',
      payload,
      ...(reason ? { reason } : {}),
      success:
        `Locked this channel. Run ${labelOf(ctx, 'lockdown', 'remove')} when it should ` +
        'reopen.',
    });
  }

  const duration = readDuration(rawDuration, 'A lockdown');
  if (isRefusal(duration)) return act(ctx, deps, duration);

  return act(ctx, deps, {
    kind: 'lockdown',
    payload,
    ...(reason ? { reason } : {}),
    expiresAt: new Date(Date.now() + duration.ms),
    success: `Locked this channel. It reopens automatically in ${formatDuration(duration.ms)}.`,
    successWithoutReversal: 'Locked this channel.',
  });
}

async function removeLockdown(ctx: Ctx, deps: ModerationDeps): Promise<void> {
  const reason = ctx.options.getString('reason');

  return act(ctx, deps, {
    kind: 'unlock',
    payload: { channelId: ctx.channelId, roleId: everyoneRoleId(ctx.guildId) },
    ...(reason ? { reason } : {}),
    success: 'Unlocked this channel.',
  });
}

export function channelCommands(deps: ModerationDeps): Command[] {
  return [slowmodeCommand(deps), lockdownCommand(deps)];
}
