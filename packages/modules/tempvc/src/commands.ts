import {
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  interactionRef,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import {
  CHANNEL_NAME_MAX,
  MODULE_ID,
  type OwnerControl,
  PRIVACY_MODES,
  type PrivacyMode,
  type TempVcConfig,
  type TempVcHub,
} from './config.ts';
import { bindService, describeUnbound, type TempVcDeps } from './deps.ts';
import { reply } from './perform.ts';
import type { TemporaryVoiceService } from './service.ts';
import type { TempVoiceChannelRow } from './table.ts';

type Command = CommandDefinition<TempVcConfig>;

const NOT_WIRED =
  "I can't reach the temporary-channel records because Proton isn't fully wired up in this " +
  'deployment. Nothing was changed. The Proton logs name the exact missing piece.';

const OFF =
  'This server has turned off member control of temporary channels. Ask a moderator to change ' +
  'the channel for you, or ask an admin to switch “Let owners manage their own channel” back on.';

const NOT_IN_ONE =
  'Run this from inside a temporary voice channel Proton made. This command only changes the ' +
  'channel you are sitting in.';

const NOT_YOURS =
  'That channel is not yours. Only its owner can change it — if the owner has left, try ' +
  '`/voice claim`.';

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
  control: OwnerControl | null,
  requireOwner = true,
): Promise<Held | null> {
  const bound = bindService(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the /voice commands', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, NOT_WIRED);
    return null;
  }

  if (!ctx.config.ownerCommands) {
    await reply(ctx, OFF);
    return null;
  }

  const row = await bound.repository.byChannel(ctx.guildId, ctx.channelId);
  if (row === null) {
    await reply(ctx, NOT_IN_ONE);
    return null;
  }

  const hub = ctx.config.hubs.find((entry) => entry.channelId === row.hubChannelId);
  if (!hub) {
    await reply(
      ctx,
      'The creator channel this was made from has been removed from the settings, so Proton no ' +
        'longer knows what it is allowed to do here.',
    );
    return null;
  }

  if (control !== null && !hub.allow[control]) {
    await reply(ctx, `This server has switched **${control}** off for these channels.`);
    return null;
  }

  if (requireOwner && row.ownerId !== ctx.userId) {
    await reply(ctx, NOT_YOURS);
    return null;
  }

  return { service: bound.service, row, hub };
}

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage the temporary voice channel you are in.')
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
      .setDescription('Set how many members may join. 0 removes the limit.')
      .addIntegerOption((option) =>
        option
          .setName('limit')
          .setDescription('0 to 99.')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(99),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('privacy')
      .setDescription('Choose who may join.')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('public, locked or private.')
          .setRequired(true)
          .addChoices(
            ...PRIVACY_MODES.map((mode) => ({
              name: mode,
              value: mode,
            })),
          ),
      ),
  );

  for (const [name, describe] of [
    ['trust', 'Let somebody join even when the channel is locked.'],
    ['untrust', 'Take back that trust.'],
    ['block', 'Keep somebody out, and disconnect them if they are inside.'],
    ['unblock', 'Lift a block.'],
    ['invite', 'Send somebody a link to your channel.'],
    ['kick', 'Disconnect somebody from your channel.'],
    ['transfer', 'Hand the channel to somebody else in it.'],
  ] as const) {
    command.addSubcommand((sub) =>
      sub
        .setName(name)
        .setDescription(describe)
        .addUserOption((option) =>
          option.setName('member').setDescription('Who.').setRequired(true),
        ),
    );
  }

  command.addSubcommand((sub) =>
    sub
      .setName('region')
      .setDescription('Pin the voice region, or let Discord choose.')
      .addStringOption((option) =>
        option.setName('region').setDescription('Leave empty for automatic.').setRequired(false),
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
    description: 'Manage the temporary voice channel you are in.',

    data: builder().toJSON(),

    async handler(ctx) {
      const sub = ctx.options.getSubcommand();

      // Deferred first: everything below reads Postgres and most of it calls Discord, and the
      // acknowledgement deadline is three seconds (I9).
      await ctx.executor.execute(
        deferEphemeral({
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          actorId: ctx.userId,
          interaction: interactionRef({
            interactionId: ctx.interaction.id,
            token: ctx.interaction.token,
            type: 2,
          } as never),
          idempotencyKey: `${ctx.idempotencyKey}:defer`,
        }),
      );

      switch (sub) {
        case 'claim':
          return claim(ctx, deps);

        case 'rename': {
          const context = await held(ctx, deps, 'rename');
          if (!context) return;

          const name = (ctx.options.getString('name') ?? '').trim();
          if (name.length === 0) {
            return reply(ctx, 'A channel needs a name — that one was empty.');
          }

          const ok = await context.service.rename(ctx, context.row, name);
          return reply(ctx, ok ? `Renamed your channel to **${name}**.` : refused('rename'));
        }

        case 'limit': {
          const context = await held(ctx, deps, 'limit');
          if (!context) return;

          const limit = ctx.options.getInteger('limit') ?? 0;
          const ok = await context.service.setLimit(ctx, context.row, limit);

          return reply(
            ctx,
            ok
              ? limit === 0
                ? 'Removed the member limit.'
                : `Your channel now holds ${limit} member${limit === 1 ? '' : 's'}.`
              : refused('limit'),
          );
        }

        case 'privacy': {
          const context = await held(ctx, deps, 'privacy');
          if (!context) return;

          const mode = (ctx.options.getString('mode') ?? 'public') as PrivacyMode;
          const ok = await context.service.applyAccess(ctx, context.row, mode);

          return reply(ctx, ok ? `Your channel is now **${mode}**.` : refused('privacy'));
        }

        case 'trust':
        case 'untrust':
        case 'block':
        case 'unblock': {
          const control: OwnerControl = sub === 'block' || sub === 'unblock' ? 'block' : 'trust';
          const context = await held(ctx, deps, control);
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return reply(ctx, 'Name somebody to change.');

          if (target === ctx.userId) {
            return reply(ctx, 'You already have access to your own channel.');
          }

          const kind = sub === 'trust' ? 'trust' : sub === 'block' ? 'block' : null;
          const ok = await context.service.setAccess(
            ctx,
            context.row,
            target,
            kind,
            context.hub.privacy,
          );

          return reply(ctx, ok ? said(sub, target) : refused(sub));
        }

        case 'kick': {
          const context = await held(ctx, deps, 'kick');
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return reply(ctx, 'Name somebody to remove.');
          if (target === ctx.userId)
            return reply(ctx, 'Use `/voice delete` to close your channel.');

          const ok = await context.service.disconnect(ctx, context.row, target);
          return reply(
            ctx,
            ok
              ? `Disconnected <@${target}>.`
              : `I could not disconnect <@${target}> — they may have already left.`,
          );
        }

        case 'invite': {
          const context = await held(ctx, deps, 'invite');
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return reply(ctx, 'Name somebody to invite.');

          // Trusted first, so the invite is not a link to a door they cannot open.
          await context.service.setAccess(ctx, context.row, target, 'trust', context.hub.privacy);

          return reply(
            ctx,
            `<@${target}> can now join <#${context.row.channelId}>. Send them the channel — ` +
              'Proton does not message members who have not asked to hear from it.',
          );
        }

        case 'transfer': {
          const context = await held(ctx, deps, 'transfer');
          if (!context) return;

          const target = ctx.options.getUserId('member');
          if (!target) return reply(ctx, 'Name who should take over.');
          if (target === ctx.userId) return reply(ctx, 'You already own this channel.');

          const ok = await context.service.transfer(ctx, context.row, target, context.hub.privacy);
          return reply(ctx, ok ? `<@${target}> owns this channel now.` : refused('transfer'));
        }

        case 'region': {
          const context = await held(ctx, deps, 'region');
          if (!context) return;

          const region = ctx.options.getString('region');
          const ok = await context.service.setRegion(ctx, context.row, region ?? null);

          return reply(
            ctx,
            ok
              ? region
                ? `Voice region pinned to **${region}**.`
                : 'Voice region back to automatic.'
              : `I could not set that region. Discord only accepts the ids it publishes.`,
          );
        }

        case 'delete': {
          const context = await held(ctx, deps, 'delete');
          if (!context) return;

          const ok = await context.service.destroy(ctx, context.row, 'deleted by its owner');
          return reply(ctx, ok ? 'Channel deleted.' : refused('delete'));
        }

        default:
          return reply(ctx, 'That subcommand is not one I know.');
      }
    },
  };
}

async function claim(ctx: CommandContext<TempVcConfig>, deps: TempVcDeps): Promise<void> {
  const context = await held(ctx, deps, 'claim', false);
  if (!context) return;

  if (context.row.ownerId !== null) {
    return reply(
      ctx,
      context.row.ownerId === ctx.userId
        ? 'You already own this channel.'
        : `<@${context.row.ownerId}> still owns this channel.`,
    );
  }

  const won = await context.service.claim(ctx, context.row, ctx.userId, context.hub.privacy);

  return reply(
    ctx,
    won ? 'You own this channel now.' : 'Somebody else claimed it a moment before you did.',
  );
}

function said(sub: string, target: string): string {
  if (sub === 'trust') return `<@${target}> can now join even when the channel is locked.`;
  if (sub === 'untrust') return `<@${target}> is no longer trusted here.`;
  if (sub === 'block') return `<@${target}> is blocked from this channel.`;

  return `<@${target}> is no longer blocked.`;
}

function refused(what: string): string {
  return `I could not ${what} your channel. Proton may be missing a permission on it — the server log names which.`;
}

export function tempVcCommands(deps: TempVcDeps): Command[] {
  return [voiceCommand(deps)];
}
