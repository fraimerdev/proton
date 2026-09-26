import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  labelOf,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import {
  CHANNEL_NAME_MAX,
  MODULE_ID,
  OWNER_CONTROL_LABELS,
  type OwnerControl,
  PRIVACY_LABELS,
  PRIVACY_MODES,
  type PrivacyMode,
  type TempVcConfig,
  type TempVcHub,
} from './config.ts';
import { bindService, describeUnbound, type TempVcDeps } from './deps.ts';
import { type Answer, acknowledge, blockAnswer, disconnectAnswer } from './perform.ts';
import type { TemporaryVoiceService } from './service.ts';
import type { TempVoiceChannelRow } from './table.ts';

type Command = CommandDefinition<TempVcConfig>;

const NOT_WIRED =
  'I can’t manage temporary voice channels right now, so nothing was changed. This is a fault on ' +
  'my side, not a setting in this server.';

const OFF =
  'This server doesn’t let owners manage their temporary channels. Ask a moderator to change ' +
  'it for you, or ask an admin to turn on “Let owners manage their own channel”.';

const NOT_IN_ONE =
  'Run this in the chat of a temporary voice channel. It only changes that channel.';

function notYours(ctx: CommandContext<TempVcConfig>): string {
  return (
    'This isn’t your channel. Only its owner can change it. If the owner has left, use ' +
    `\`${labelOf(ctx, 'voice', 'claim')}\`.`
  );
}

export interface Held {
  service: TemporaryVoiceService;
  row: TempVoiceChannelRow;
  hub: TempVcHub;
}

/**
 * Every command re-derives who owns the channel from the database. The interaction says which
 * channel it came from and nothing about who may change it, so authorisation is never taken from
 * the caller — a member can always ask about a channel that is not theirs.
 */
async function held(
  ctx: CommandContext<TempVcConfig>,
  deps: TempVcDeps,
  answer: Answer,
  control: OwnerControl | null,
  requireOwner = true,
): Promise<Held | null> {
  const bound = bindService(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the /voice commands', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await answer(errorStatus(NOT_WIRED));
    return null;
  }

  if (!ctx.config.ownerCommands) {
    await answer(errorStatus(OFF));
    return null;
  }

  const row = await bound.repository.byChannel(ctx.guildId, ctx.channelId);
  if (row === null) {
    await answer(errorStatus(NOT_IN_ONE));
    return null;
  }

  const hub = ctx.config.hubs.find((entry) => entry.channelId === row.hubChannelId);
  if (!hub) {
    await answer(
      errorStatus(
        'The creator channel this came from was removed from the settings, so this channel can’t ' +
          'be changed.',
      ),
    );
    return null;
  }

  if (control !== null && !hub.allow[control]) {
    await answer(
      errorStatus(
        `This server has turned off **${OWNER_CONTROL_LABELS[control]}** for temporary channels.`,
      ),
    );
    return null;
  }

  if (requireOwner && row.ownerId !== ctx.userId) {
    await answer(errorStatus(notYours(ctx)));
    return null;
  }

  return { service: bound.service, row, hub };
}

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage your temporary voice channel.')
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename your channel.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('The new name.')
          .setRequired(true)
          .setMaxLength(CHANNEL_NAME_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('limit')
      .setDescription('Set how many members can join your channel.')
      .addIntegerOption((option) =>
        option
          .setName('limit')
          .setDescription('The member limit, from 0 to 99. 0 removes the limit.')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(99),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('privacy')
      .setDescription('Choose who can join your channel.')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Who can join.')
          .setRequired(true)
          .addChoices(
            ...PRIVACY_MODES.map((mode) => ({
              name: PRIVACY_LABELS[mode],
              value: mode,
            })),
          ),
      ),
  );

  for (const [name, describe, whom] of [
    [
      'trust',
      'Let a member join, even when your channel is locked or private.',
      'The member to trust.',
    ],
    ['untrust', 'Stop trusting a member.', 'The member to stop trusting.'],
    ['block', 'Keep a member out, and disconnect them if they’re in.', 'The member to block.'],
    ['unblock', 'Unblock a member.', 'The member to unblock.'],
    [
      'invite',
      'Give a member access to your channel so you can invite them.',
      'The member to invite.',
    ],
    ['kick', 'Disconnect a member from your channel.', 'The member to disconnect.'],
    ['transfer', 'Make another member the owner of your channel.', 'The new owner.'],
  ] as const) {
    command.addSubcommand((sub) =>
      sub
        .setName(name)
        .setDescription(describe)
        .addUserOption((option) => option.setName('member').setDescription(whom).setRequired(true)),
    );
  }

  command.addSubcommand((sub) =>
    sub
      .setName('region')
      .setDescription('Set your channel’s voice region, or let Discord choose.')
      .addStringOption((option) =>
        option
          .setName('region')
          .setDescription('A region ID such as us-east or rotterdam. Leave empty for automatic.')
          .setRequired(false),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('claim').setDescription('Take over a channel whose owner has left.'),
  );

  command.addSubcommand((sub) => sub.setName('delete').setDescription('Delete your channel now.'));

  return command;
}

export function voiceCommand(deps: TempVcDeps): Command {
  return {
    name: 'voice',
    description: 'Manage your temporary voice channel.',

    data: builder().toJSON(),

    async handler(ctx) {
      const sub = ctx.options.getSubcommand();
      const answer = await acknowledge(ctx);

      switch (sub) {
        case 'claim':
          return claim(ctx, deps, answer);

        case 'rename': {
          const context = await held(ctx, deps, answer, 'rename');
          if (!context) return;

          const name = (ctx.options.getString('name') ?? '').trim();
          if (name.length === 0) {
            return answer(errorStatus('The name can’t be empty.'));
          }

          const ok = await context.service.rename(ctx, context.row, name);
          return answer(
            ok
              ? successStatus(`Renamed your channel to **${name}**.`)
              : refused('rename your channel'),
          );
        }

        case 'limit': {
          const context = await held(ctx, deps, answer, 'limit');
          if (!context) return;

          const limit = ctx.options.getInteger('limit') ?? 0;
          const ok = await context.service.setLimit(ctx, context.row, limit);

          return answer(
            ok
              ? successStatus(
                  limit === 0
                    ? 'Removed the member limit from your channel.'
                    : `Set your channel’s member limit to ${limit}.`,
                )
              : refused('set that member limit'),
          );
        }

        case 'privacy': {
          const context = await held(ctx, deps, answer, 'privacy');
          if (!context) return;

          const mode = (ctx.options.getString('mode') ?? 'public') as PrivacyMode;
          const ok = await context.service.applyAccess(ctx, context.row, mode);

          return answer(
            ok ? successStatus(`Your channel is now **${mode}**.`) : refused('change who can join'),
          );
        }

        case 'trust':
        case 'untrust':
        case 'block':
        case 'unblock': {
          const control: OwnerControl = sub === 'block' || sub === 'unblock' ? 'block' : 'trust';
          const context = await held(ctx, deps, answer, control);
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return answer(errorStatus('Choose a member.'));

          if (target === ctx.userId) {
            return answer(errorStatus('You already have access to your own channel.'));
          }

          const kind = sub === 'trust' ? 'trust' : sub === 'block' ? 'block' : null;
          const outcome = await context.service.setAccess(
            ctx,
            context.row,
            target,
            kind,
            context.hub.privacy,
          );

          if (!outcome.applied) return answer(refused(`${sub} that member`));

          return answer(
            sub === 'block'
              ? blockAnswer(outcome.disconnect, target)
              : successStatus(said(sub, target)),
          );
        }

        case 'kick': {
          const context = await held(ctx, deps, answer, 'kick');
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return answer(errorStatus('Choose a member to disconnect.'));
          if (target === ctx.userId)
            return answer(
              errorStatus(`Use \`${labelOf(ctx, 'voice', 'delete')}\` to close your channel.`),
            );

          const outcome = await context.service.disconnect(ctx, context.row, target);
          return answer(disconnectAnswer(outcome, target));
        }

        case 'invite': {
          const context = await held(ctx, deps, answer, 'invite');
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return answer(errorStatus('Choose a member to invite.'));

          // Trusted first, so the invite is not a link to a door they cannot open.
          const { applied } = await context.service.setAccess(
            ctx,
            context.row,
            target,
            'trust',
            context.hub.privacy,
          );

          return answer(
            applied
              ? successStatus(
                  `<@${target}> can now join <#${context.row.channelId}>. I don’t DM invites, so ` +
                    'send them the channel yourself.',
                )
              : refused('invite that member'),
          );
        }

        case 'transfer': {
          const context = await held(ctx, deps, answer, 'transfer');
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return answer(errorStatus('Choose the new owner.'));
          if (target === ctx.userId) return answer(errorStatus('You already own this channel.'));

          const ok = await context.service.transfer(ctx, context.row, target, context.hub.privacy);
          return answer(
            ok
              ? successStatus(`<@${target}> owns this channel now.`)
              : refused('hand over your channel'),
          );
        }

        case 'region': {
          const context = await held(ctx, deps, answer, 'region');
          if (!context) return;

          const region = ctx.options.getString('region');
          const ok = await context.service.setRegion(ctx, context.row, region ?? null);

          return answer(
            ok
              ? successStatus(
                  region
                    ? `Set your channel’s voice region to **${region}**.`
                    : 'Set your channel’s voice region to automatic.',
                )
              : errorStatus(
                  'Couldn’t set that region. Check that it’s a region ID Discord lists, such as ' +
                    'us-east or rotterdam.',
                ),
          );
        }

        case 'delete': {
          const context = await held(ctx, deps, answer, 'delete');
          if (!context) return;

          const ok = await context.service.destroy(ctx, context.row, 'deleted by its owner');
          return answer(
            ok ? successStatus('Deleted your channel.') : refused('delete your channel'),
          );
        }

        default:
          return answer(errorStatus('I don’t know that subcommand.'));
      }
    },
  };
}

async function claim(
  ctx: CommandContext<TempVcConfig>,
  deps: TempVcDeps,
  answer: Answer,
): Promise<void> {
  const context = await held(ctx, deps, answer, 'claim', false);
  if (!context) return;

  if (context.row.ownerId !== null) {
    return answer(
      errorStatus(
        context.row.ownerId === ctx.userId
          ? 'You already own this channel.'
          : `<@${context.row.ownerId}> still owns this channel.`,
      ),
    );
  }

  const won = await context.service.claim(ctx, context.row, ctx.userId, context.hub.privacy);

  return answer(
    won
      ? successStatus('You own this channel now.')
      : errorStatus('Someone else claimed it just before you.'),
  );
}

function said(sub: string, target: string): string {
  if (sub === 'trust') {
    return `<@${target}> can now join your channel, even when it’s locked or private.`;
  }
  if (sub === 'untrust') return `<@${target}> is no longer trusted in your channel.`;

  return `<@${target}> is no longer blocked from your channel.`;
}

function refused(what: string): StatusBody {
  return errorStatus(
    `Couldn’t ${what}. I might be missing Manage Channels or Manage Roles in this channel. Ask ` +
      'an admin to check.',
  );
}

export function tempVcCommands(deps: TempVcDeps): Command[] {
  return [voiceCommand(deps)];
}
