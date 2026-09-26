import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  labelOf,
  Permissions,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { LevelingConfig } from './config.ts';
import { levelProgress, MAX_XP } from './curve.ts';
import { bindXp, clockOf, describeUnbound, type LevelingDeps } from './deps.ts';
import { addXpEventGroup, runXpEventCommand, XP_EVENT_GROUP } from './event-commands.ts';
import { applyLevelUp } from './level-up.ts';
import { acknowledge, MODULE_ID, reply } from './perform.ts';
import { adminCausation, publishXpAwarded } from './publish.ts';
import { renderRankCard } from './rank-card.ts';
import type { MemberXpStore, XpAdjustment } from './store.ts';

type Command = CommandDefinition<LevelingConfig>;

export const LEADERBOARD_PAGE_SIZE = 10;

export const LEADERBOARD_MAX_PAGE = 1000;

const XP_PUBLIC_PATHS: ReadonlySet<string> = new Set(['give', 'take', 'set']);

async function ready(
  ctx: CommandContext<LevelingConfig>,
  deps: LevelingDeps,
): Promise<MemberXpStore | null> {
  if (!ctx.config.enabled) {
    await reply(
      ctx,
      errorStatus(
        'Leveling is off in this server. An admin can turn it on in the Proton dashboard.',
      ),
      { ephemeral: true },
    );
    return null;
  }

  const bound = bindXp(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('XP storage', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(
      ctx,
      errorStatus(
        "I can't reach this server's XP records right now. Nothing was changed. This is a fault " +
          'on my side, not a setting in this server.',
      ),
      { ephemeral: true },
    );
    return null;
  }

  return bound.xp;
}

export function rankCommand(deps: LevelingDeps): Command {
  return {
    name: 'rank',
    description: 'Show a member’s level, XP and place on the leaderboard.',

    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Show a member’s level, XP and place on the leaderboard.')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('user').setDescription('Whose rank to show. Defaults to you.'),
      )
      .toJSON(),

    reply: { default: 'public', toggleable: [''] },

    async handler(ctx) {
      const xp = await ready(ctx, deps);
      if (!xp) return;

      const say = await acknowledge(ctx, deps, ctx.privateReply ?? false);
      const userId = ctx.options.getUserId('user') ?? ctx.userId;
      const record = await xp.get(ctx.guildId, userId);

      if (record === null || record.xp <= 0) {
        await say(
          userId === ctx.userId
            ? 'You haven’t earned any XP in this server yet.'
            : `<@${userId}> hasn’t earned any XP in this server yet.`,
        );
        return;
      }

      const progress = levelProgress(record.xp);

      const card = ctx.config.rankCard
        ? await renderRankCard(ctx, deps, {
            userId,
            preset: ctx.config.cardPreset,
            level: progress.level,
            rank: record.rank,
            totalXp: record.xp,
            into: progress.into,
            span: progress.span,
          })
        : null;

      if (card) {
        await say('', [card]);
        return;
      }

      // Not a written-out version of the card: a reply carrying neither content nor attachment is
      // the one thing Discord refuses, so the no-card paths have to say why there is no card.
      await say(
        errorStatus(
          ctx.config.rankCard
            ? 'Couldn’t draw the rank card right now. Try again in a moment.'
            : 'Rank cards are off in this server. An admin can turn them on in the Proton ' +
                'dashboard.',
        ),
      );
    },
  };
}

export function leaderboardCommand(deps: LevelingDeps): Command {
  return {
    name: 'leaderboard',
    description: 'Show this server’s XP leaderboard.',

    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show this server’s XP leaderboard.')
      .setContexts(InteractionContextType.Guild)
      .addIntegerOption((option) =>
        option
          .setName('page')
          .setDescription(`Which page, ${LEADERBOARD_PAGE_SIZE} members each. Defaults to 1.`)
          .setMinValue(1)
          .setMaxValue(LEADERBOARD_MAX_PAGE),
      )
      .toJSON(),

    reply: { default: 'public', toggleable: [''] },

    async handler(ctx) {
      const xp = await ready(ctx, deps);
      if (!xp) return;

      const say = await acknowledge(ctx, deps, ctx.privateReply ?? false);
      const page = Math.min(Math.max(1, ctx.options.getInteger('page') ?? 1), LEADERBOARD_MAX_PAGE);
      const entries = await xp.leaderboard(ctx.guildId, {
        limit: LEADERBOARD_PAGE_SIZE,
        offset: (page - 1) * LEADERBOARD_PAGE_SIZE,
      });

      if (entries.length === 0) {
        await say(
          page === 1
            ? 'Nobody has earned any XP in this server yet.'
            : errorStatus(`There’s no page ${page}. The leaderboard is shorter than that.`),
        );
        return;
      }

      const lines = entries.map(
        (entry) =>
          `**${entry.rank}.** <@${entry.userId}> · Level ${entry.level} · ${count(entry.xp)} XP`,
      );

      await say([`**XP leaderboard** (page ${page})`, ...lines].join('\n'));
    },
  };
}

export function xpCommand(deps: LevelingDeps): Command {
  return {
    name: 'xp',
    description: 'Adjust a member’s XP or run an XP event.',

    data: new SlashCommandBuilder()
      .setName('xp')
      .setDescription('Adjust a member’s XP or run an XP event.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('give')
          .setDescription('Add XP to a member’s total.')
          .addUserOption((option) =>
            option.setName('user').setDescription('Who gets the XP.').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('How much XP to add.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(MAX_XP),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('take')
          .setDescription('Remove XP from a member’s total.')
          .addUserOption((option) =>
            option.setName('user').setDescription('Who loses the XP.').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('How much XP to remove. Their total won’t go below 0.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(MAX_XP),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set a member’s total to an exact amount.')
          .addUserOption((option) =>
            option.setName('user').setDescription('Whose XP to set.').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('Their new XP total.')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(MAX_XP),
          ),
      )
      .addSubcommandGroup(addXpEventGroup)
      .toJSON(),

    reply: {
      default: (_config, path) => (XP_PUBLIC_PATHS.has(path) ? 'public' : 'private'),
      toggleable: [...XP_PUBLIC_PATHS],
    },

    async handler(ctx) {
      if (ctx.options.getSubcommandGroup() === XP_EVENT_GROUP) {
        if (!ctx.config.enabled) {
          await reply(
            ctx,
            errorStatus(
              'Leveling is off in this server, so an XP event would do nothing. An admin can ' +
                'turn it on in the Proton dashboard.',
            ),
            { ephemeral: true },
          );
          return;
        }

        await runXpEventCommand(ctx, deps);
        return;
      }

      const store = await ready(ctx, deps);
      if (!store) return;

      const adjustment = readAdjustment(ctx.options.getSubcommand());
      if (adjustment === null) {
        await reply(
          ctx,
          errorStatus(
            `Use ${labelOf(ctx, 'xp', 'give')}, ${labelOf(ctx, 'xp', 'take')} or ` +
              `${labelOf(ctx, 'xp', 'set')}.`,
          ),
          { ephemeral: true },
        );
        return;
      }

      const userId = ctx.options.getUserId('user');
      const amount = ctx.options.getInteger('amount');

      if (!userId || amount === null) {
        await reply(ctx, errorStatus('I need a member and an amount.'), { ephemeral: true });
        return;
      }

      const say = await acknowledge(ctx, deps, ctx.privateReply ?? false);
      const now = clockOf(deps)();
      const result = await store.adjust({
        guildId: ctx.guildId,
        userId,
        adjustment,
        amount,

        now,
      });

      ctx.logger.info(`/xp ${adjustment} ${amount} for ${userId}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId,
        actorId: ctx.userId,
        xp: result.xp,
      });

      const moved =
        result.level > result.previousLevel
          ? `, up from ${result.previousLevel}`
          : result.level < result.previousLevel
            ? `, down from ${result.previousLevel}`
            : '';

      await say(
        successStatus(
          `<@${userId}> now has ${count(result.xp)} XP (level ${result.level}${moved}).`,
        ),
      );

      const causation = adminCausation(ctx.idempotencyKey);

      await applyLevelUp(
        ctx,
        {
          userId,
          previousLevel: result.previousLevel,
          level: result.level,
          xp: result.xp,
          source: 'admin',
          idempotencyRoot: `leveling:${ctx.idempotencyKey}`,
          originChannelId: ctx.channelId,
          ...(adjustment === 'give' ? { gained: amount } : {}),
          causation,
        },
        deps,
      );

      if (adjustment !== 'give') return;

      await publishXpAwarded(ctx, ctx.idempotencyKey, {
        userId,
        amount,
        source: 'admin',
        channelId: ctx.channelId,
        activityAt: now,
        xp: result.xp,
        level: result.level,
        causation,
      });
    },
  };
}

export function levelingCommands(deps: LevelingDeps): Command[] {
  return [rankCommand(deps), leaderboardCommand(deps), xpCommand(deps)];
}

function readAdjustment(value: string | null): XpAdjustment | null {
  return value === 'give' || value === 'take' || value === 'set' ? value : null;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}
