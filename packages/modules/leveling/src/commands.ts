import { type CommandContext, type CommandDefinition, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { LevelingConfig } from './config.ts';
import { levelProgress, MAX_XP } from './curve.ts';
import { bindXp, clockOf, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { MODULE_ID, reply } from './perform.ts';
import type { MemberXpStore, XpAdjustment } from './store.ts';

type Command = CommandDefinition<LevelingConfig>;

/** Ten rows fits inside Discord's 2000-character message limit with room to spare. */
export const LEADERBOARD_PAGE_SIZE = 10;

/** Bounded so a page number cannot ask Postgres for a million-row offset. */
export const LEADERBOARD_MAX_PAGE = 1000;

/**
 * Every command starts here: the module has to be on and its store bound, or
 * there is nothing truthful to answer with.
 *
 * A disabled module still replies. Returning silently would leave Discord
 * showing "This interaction failed" — indistinguishable from a crash, and the
 * invoker would have no idea a human switched it off (§1, I9).
 */
async function ready(
  ctx: CommandContext<LevelingConfig>,
  deps: LevelingDeps,
): Promise<MemberXpStore | null> {
  if (!ctx.config.enabled) {
    await reply(
      ctx,
      'Leveling is switched off in this server, so there is no XP to report. An admin can ' +
        'turn it on from the Proton dashboard.',
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
      "I can't read this server's XP because Proton isn't fully wired up in this deployment. " +
        'Nothing was changed. The Proton logs name the exact missing piece.',
      { ephemeral: true },
    );
    return null;
  }

  return bound.xp;
}

/**
 * `/rank` — where one member stands.
 *
 * Public rather than ephemeral, deliberately: a rank is a thing people show each
 * other, and an ephemeral reply to `/rank @someone` would make the answer
 * invisible to the person who was asked about.
 */
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

    async handler(ctx) {
      const xp = await ready(ctx, deps);
      if (!xp) return;

      const userId = ctx.options.getUserId('user') ?? ctx.userId;
      const record = await xp.get(ctx.guildId, userId);

      if (record === null || record.xp <= 0) {
        await reply(
          ctx,
          userId === ctx.userId
            ? 'You have not earned any XP in this server yet. Join a conversation.'
            : `<@${userId}> has not earned any XP in this server yet.`,
        );
        return;
      }

      const progress = levelProgress(record.xp);
      const next =
        progress.span === 0
          ? `That is the highest level Proton awards — ${count(record.xp)} XP and still counting.`
          : `${count(progress.remaining)} XP to level ${progress.level + 1} ` +
            `(${count(progress.into)}/${count(progress.span)}).`;

      await reply(
        ctx,
        `**<@${userId}>** — level ${progress.level}, ${count(record.xp)} XP, ` +
          `rank #${count(record.rank)}.\n${next}`,
      );
    },
  };
}

/**
 * `/leaderboard` — a page of the guild's board.
 *
 * Paged rather than truncated, because "top 10 and nothing else" makes the
 * feature useless to the ninetieth member, and a full board does not fit in a
 * Discord message. The dashboard's table (§3.G) is the place to browse it
 * properly; this is the version you can run without leaving the chat.
 */
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

    async handler(ctx) {
      const xp = await ready(ctx, deps);
      if (!xp) return;

      const page = Math.min(Math.max(1, ctx.options.getInteger('page') ?? 1), LEADERBOARD_MAX_PAGE);
      const entries = await xp.leaderboard(ctx.guildId, {
        limit: LEADERBOARD_PAGE_SIZE,
        offset: (page - 1) * LEADERBOARD_PAGE_SIZE,
      });

      if (entries.length === 0) {
        await reply(
          ctx,
          page === 1
            ? 'Nobody has earned any XP in this server yet.'
            : `There is no page ${page} — the leaderboard is shorter than that.`,
        );
        return;
      }

      const lines = entries.map(
        (entry) =>
          `**${entry.rank}.** <@${entry.userId}> — level ${entry.level}, ${count(entry.xp)} XP`,
      );

      await reply(ctx, [`**XP leaderboard** (page ${page})`, ...lines].join('\n'));
    },
  };
}

/**
 * `/xp give|take|set` — the admin escape hatch.
 *
 * MANAGE_GUILD as `default_member_permissions`, which is presentation rather
 * than authorisation: Discord's own gate can be overridden per guild, and the
 * `permissions` module's overrides are applied by the runtime before the handler
 * runs. What this command changes is a number, so there is no I8 hierarchy
 * question to answer — but the level-up it can cause goes through exactly the
 * same path a chat level-up does, reward roles and published event included.
 */
export function xpCommand(deps: LevelingDeps): Command {
  return {
    name: 'xp',
    description: 'Adjust a member’s XP.',

    data: new SlashCommandBuilder()
      .setName('xp')
      .setDescription('Adjust a member’s XP.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('give')
          .setDescription('Add XP to a member’s total.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member.').setRequired(true),
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
            option.setName('user').setDescription('The member.').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('How much XP to remove. Stops at zero.')
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
            option.setName('user').setDescription('The member.').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('The new total.')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(MAX_XP),
          ),
      )
      .toJSON(),

    async handler(ctx) {
      const store = await ready(ctx, deps);
      if (!store) return;

      const adjustment = readAdjustment(ctx.options.getSubcommand());
      if (adjustment === null) {
        // Only reachable if the registered command and this handler disagree,
        // which is a build problem rather than something an admin did.
        await reply(ctx, 'Use /xp give, /xp take or /xp set.', { ephemeral: true });
        return;
      }

      const userId = ctx.options.getUserId('user');
      const amount = ctx.options.getInteger('amount');

      if (!userId || amount === null) {
        await reply(ctx, 'I need a member and an amount.', { ephemeral: true });
        return;
      }

      const result = await store.adjust({
        guildId: ctx.guildId,
        userId,
        adjustment,
        amount,
        // A command has no event timestamp to work from — this is the one path in
        // the module that reads a clock, and it is injectable so tests can pin it.
        now: clockOf(deps)(),
      });

      ctx.logger.info(`/xp ${adjustment} ${amount} for ${userId}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId,
        actorId: ctx.userId,
        xp: result.xp,
      });

      await reply(
        ctx,
        `<@${userId}> is now on ${count(result.xp)} XP — level ${result.level}` +
          `${result.level === result.previousLevel ? '' : `, up from ${result.previousLevel}`}.`,
      );

      // A level gained is a level gained, whoever caused it: the reward roles and
      // the event are the ones a chat level-up produces. A level *lost*
      // deliberately does nothing — see `applyLevelUp`.
      await applyLevelUp(ctx, {
        userId,
        previousLevel: result.previousLevel,
        level: result.level,
        xp: result.xp,
        source: 'admin',
        idempotencyRoot: `leveling:${ctx.idempotencyKey}`,
        originChannelId: ctx.channelId,
      });
    },
  };
}

/**
 * The three commands, bound to the module's ports.
 *
 * Factories rather than constants, for the same reason the manifest is one: §7
 * hands a command context no storage, so the store has to be closed over at
 * construction.
 */
export function levelingCommands(deps: LevelingDeps): Command[] {
  return [rankCommand(deps), leaderboardCommand(deps), xpCommand(deps)];
}

function readAdjustment(value: string | null): XpAdjustment | null {
  return value === 'give' || value === 'take' || value === 'set' ? value : null;
}

/** Thousands separators, so six-figure totals are readable at a glance. */
function count(value: number): string {
  return value.toLocaleString('en-US');
}
