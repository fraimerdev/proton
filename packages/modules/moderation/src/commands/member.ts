import {
  type CommandContext,
  type CommandDefinition,
  caseIdSchema,
  formatDuration,
  Permissions,
  snowflakeSchema,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
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

export function warnCommand(deps: ModerationDeps): Command {
  return {
    name: 'warn',
    description: 'Warn a member, or withdraw a warning.',

    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member, or withdraw a warning.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ModerateMembers)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Record a warning against a member.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to warn.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription('Shown in the case and to the member.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Withdraw a warning, so it stops counting against the member.')
          .addStringOption((option) =>
            option
              .setName('case')
              .setDescription('Case id of the warning, printed under it — like K7f3M2q.')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addStringOption((option) =>
            option
              .setName('reason')
              .setDescription('Written to the case that records the withdrawal.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .toJSON(),

    async handler(ctx) {
      switch (ctx.options.getSubcommand()) {
        case 'add':
          return addWarn(ctx);
        case 'remove':
          return removeWarn(ctx, deps);
        default:
          return perform(ctx, {
            refusal:
              'Use /warn add to warn somebody, or /warn remove to withdraw a warning by its case id.',
          });
      }
    },
  };
}

async function addWarn(ctx: CommandContext<ModerationConfig>): Promise<void> {
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
}

async function removeWarn(
  ctx: CommandContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<void> {
  const store = deps.warnings;
  if (!store) {
    return perform(ctx, {
      refusal:
        'I cannot read this server’s case ledger, so I cannot withdraw a warning. Nothing has ' +
        'changed. This is a Proton problem, not a setting in this server.',
    });
  }

  const caseId = ctx.options.getString('case')?.trim() ?? '';

  // Not echoed back: the option is free text until it parses, and publicReplies would put whatever
  // was typed — @everyone included — into a message Proton posts in the channel.
  if (!caseIdSchema.safeParse(caseId).success) {
    return perform(ctx, {
      refusal:
        'That is not a case id. It is the code printed under the warning itself, like ' +
        '`K7f3M2q`, and you can also read it off the Cases page in the dashboard.',
    });
  }

  const reason = ctx.options.getString('reason');

  const warning = await store.find(ctx.guildId, caseId);
  if (!warning) {
    return perform(ctx, {
      refusal:
        `No warning in this server carries case id \`${caseId}\`. Check it against the Cases ` +
        'page in the dashboard — a ban or a kick has a case id too, but only a warning can be ' +
        'withdrawn this way.',
    });
  }

  if (warning.revertedAt) {
    const by = warning.revertedBy ? ` by <@${warning.revertedBy}>` : '';
    return perform(ctx, {
      refusal: `Warning \`${caseId}\` was already withdrawn${by}. Nothing has changed.`,
    });
  }

  const targetId = warning.targetId;
  if (!targetId) {
    return perform(ctx, {
      refusal:
        `Warning \`${caseId}\` names nobody, so there is nothing to clear it from. This is a ` +
        'Proton problem, not a setting in this server.',
    });
  }

  // The stamp goes on inside onRecorded, after the ledger entry exists — the two writes cannot
  // share a transaction, and this is the order whose half-done state a moderator can recover from
  // by running the command again. Stamping first and dying before the ledger insert would leave a
  // warning that is withdrawn, unrecorded, and refuses every later attempt to record it.
  return perform(ctx, {
    kind: 'unwarn',
    targetId,
    payload: { userId: targetId, caseId },
    ...(reason ? { reason } : {}),
    success:
      `Withdrew warning \`${caseId}\` against <@${targetId}>. It no longer counts as active ` +
      'moderation against them, and any escalation it already triggered stands.',

    successWithoutFollowUp:
      `Warning \`${caseId}\` is still standing against <@${targetId}> — I recorded the ` +
      'withdrawal but could not strike the warning itself, so nothing has changed for them. ' +
      'Run the command again.',

    async onRecorded() {
      const withdrawn = await store.withdraw({
        guildId: ctx.guildId,
        caseId,
        at: new Date(),
        by: ctx.userId,
      });

      if (!withdrawn) throw new Error(`case ${caseId} was already withdrawn`);
    },
  });
}

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
  description: 'Time a member out, or end a timeout early.',

  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Time a member out, or end a timeout early.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(Permissions.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Time a member out for a while.')
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
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('End a timeout early.')
        .addUserOption((option) =>
          option.setName('user').setDescription('The member to release.').setRequired(true),
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
        return addTimeout(ctx);
      case 'remove':
        return removeTimeout(ctx);
      default:
        return perform(ctx, {
          refusal:
            'Use /timeout add to time somebody out, or /timeout remove to end a timeout early.',
        });
    }
  },
};

async function addTimeout(ctx: CommandContext<ModerationConfig>): Promise<void> {
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
}

async function removeTimeout(ctx: CommandContext<ModerationConfig>): Promise<void> {
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
}

export function memberCommands(deps: ModerationDeps): Command[] {
  return [banCommand, kickCommand, timeoutCommand, warnCommand(deps)];
}
