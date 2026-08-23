import {
  type CommandContext,
  type CommandDefinition,
  type PermissionOverwriteSpec,
  Permissions,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { CHANNEL_NAME_MAX, MODULE_ID, type TempVcConfig } from './config.ts';
import { bindStore, describeUnbound, type TempVcDeps } from './deps.ts';
import { reply } from './perform.ts';
import type { TempVcStore } from './store.ts';

type Command = CommandDefinition<TempVcConfig>;

const NOT_WIRED =
  "I can't reach the temporary-channel records because Proton isn't fully wired up in this " +
  'deployment. Nothing was changed. The Proton logs name the exact missing piece.';

const NOT_YOURS =
  'Run this in your own temporary voice channel — the one Proton made when you joined a hub. ' +
  'This command only changes that channel, and only for whoever it was made for.';

// edit_channel replaces the whole array, so lock and unlock have to start from what the channel
// already has: sending a bare [{ @everyone deny }] — or a bare [] — throws away every other
// overwrite on the channel, including the ones that let the owner in.
function fromGuildState(
  overwrites: ReadonlyArray<{ id: string; type: 0 | 1; allow: bigint; deny: bigint }>,
): PermissionOverwriteSpec[] {
  return overwrites.map((entry) => ({
    id: entry.id,
    type: entry.type,
    allow: entry.allow.toString(),
    deny: entry.deny.toString(),
  }));
}

// The @everyone role id is always the guild id, which is why this needs no role lookup.
export function withConnect(
  overwrites: readonly PermissionOverwriteSpec[],
  guildId: string,
  allowed: boolean,
): PermissionOverwriteSpec[] {
  const others = overwrites.filter((entry) => !(entry.id === guildId && entry.type === 0));
  const existing = overwrites.find((entry) => entry.id === guildId && entry.type === 0);

  const deny = BigInt(existing?.deny ?? '0');
  const next = allowed ? deny & ~Permissions.Connect : deny | Permissions.Connect;

  const allow = BigInt(existing?.allow ?? '0') & ~Permissions.Connect;

  if (next === 0n && allow === 0n) return others;

  return [...others, { id: guildId, type: 0, allow: allow.toString(), deny: next.toString() }];
}

async function owned(
  ctx: CommandContext<TempVcConfig>,
  deps: TempVcDeps,
): Promise<{ store: TempVcStore; channelId: string } | null> {
  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the /vc commands', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, NOT_WIRED);
    return null;
  }

  if (!ctx.config.ownerCommands) {
    await reply(
      ctx,
      'This server has turned off member control of temporary channels. Ask a moderator to ' +
        'change the channel for you, or ask an admin to switch “Let owners manage their own ' +
        'channel” back on in the Proton dashboard.',
    );
    return null;
  }

  const channel = await bound.store.get(ctx.guildId, ctx.channelId);
  if (channel === null || channel.ownerId !== ctx.userId) {
    await reply(ctx, NOT_YOURS);
    return null;
  }

  return { store: bound.store, channelId: ctx.channelId };
}

async function edit(
  ctx: CommandContext<TempVcConfig>,
  channelId: string,
  payload: Record<string, unknown>,
  confirmation: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: ctx.userId,
    reason: `${ctx.userId} changed their temporary voice channel`,
    idempotencyKey: `${ctx.idempotencyKey}:edit`,
    dryRun: false,
    payload: { channelId, ...payload },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await reply(
      ctx,
      `I couldn't change your channel: ${result.failure?.humanReason ?? 'unknown reason'}`,
      'refused',
    );
    return;
  }

  await reply(ctx, confirmation, 'done');
}

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('vc')
    .setDescription('Change the temporary voice channel you are in.')
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub
      .setName('name')
      .setDescription('Rename your temporary channel.')
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
    sub.setName('lock').setDescription('Stop anyone else from joining your channel.'),
  );

  command.addSubcommand((sub) =>
    sub.setName('unlock').setDescription('Let members join your channel again.'),
  );

  return command;
}

export function vcCommand(deps: TempVcDeps): Command {
  return {
    name: 'vc',
    description: 'Change the temporary voice channel you are in.',

    data: builder().toJSON(),

    async handler(ctx) {
      const context = await owned(ctx, deps);
      if (context === null) return;

      const { channelId } = context;

      switch (ctx.options.getSubcommand()) {
        case 'name': {
          const name = (ctx.options.getString('name') ?? '').trim();
          if (name.length === 0) {
            await reply(ctx, 'A channel needs a name — that one was empty.');
            return;
          }

          return edit(ctx, channelId, { name }, `Renamed your channel to **${name}**.`);
        }

        case 'limit': {
          const limit = ctx.options.getInteger('limit') ?? 0;

          return edit(
            ctx,
            channelId,
            { userLimit: limit },
            limit === 0
              ? 'Removed the member limit on your channel.'
              : `Your channel now holds ${limit} member(s).`,
          );
        }

        case 'lock':
        case 'unlock': {
          const allowed = ctx.options.getSubcommand() === 'unlock';

          const live = (await deps.guildState?.get(ctx.guildId))?.channels.get(channelId);
          if (!live) {
            await reply(
              ctx,
              "I don't have this server's channel list cached yet, so I can't change who may " +
                'join without risking wiping the channel’s other permissions. Try again shortly.',
            );
            return;
          }

          return edit(
            ctx,
            channelId,
            {
              permissionOverwrites: withConnect(
                fromGuildState(live.overwrites),
                ctx.guildId,
                allowed,
              ),
            },
            allowed
              ? 'Unlocked your channel. Anyone who can see it may join again.'
              : 'Locked your channel. Nobody else can join until you unlock it.',
          );
        }

        default:
          await reply(ctx, 'That subcommand is not one I know.');
      }
    },
  };
}

export function tempVcCommands(deps: TempVcDeps): Command[] {
  return [vcCommand(deps)];
}
