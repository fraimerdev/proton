import { describeMultipliers, describeRequirements, type ProviderRegistry } from '@proton/core';
import { cardFor, renderCard } from './embed.ts';
import type { DrawSummary } from './end.ts';
import { publishDrawn } from './events.ts';
import { announcement, claimRow, rerollAnnouncement, viewOf } from './message.ts';
import {
  announceWinners,
  type Ctx,
  dmWinner,
  editGiveaway,
  grantRewardRole,
  notifyHost,
  recordDrawCase,
} from './perform.ts';
import { describePrizes, parsePrizes, prizesForWinners } from './prizes.ts';
import type { Giveaway, GiveawayStore } from './store.ts';

export interface PublishDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
}

async function describeBoth(
  deps: PublishDeps,
  giveaway: Giveaway,
): Promise<{ requirements: string[]; multipliers: string[] }> {
  const [requirementRows, multiplierRows] = await Promise.all([
    deps.store.requirements(giveaway.id),
    deps.store.multipliers(giveaway.id),
  ]);

  return {
    requirements: describeRequirements(
      deps.providers,
      requirementRows.map((row) => ({ providerId: row.providerId, config: row.config })),
    ),
    multipliers: describeMultipliers(
      deps.providers,
      multiplierRows.map((row) => ({
        providerId: row.providerId,
        config: row.config,
        mode: row.mode,
      })),
    ),
  };
}

export async function refreshMessage(
  ctx: Ctx,
  deps: PublishDeps,
  giveaway: Giveaway,
  idempotencyKey: string,
): Promise<boolean> {
  if (giveaway.messageId === null) return false;

  const [{ requirements, multipliers }, entrantCount] = await Promise.all([
    describeBoth(deps, giveaway),
    deps.store.entrantCount(giveaway.id),
  ]);

  const rendered = renderCard(cardFor(giveaway.status, [], giveaway.entryMethod), {
    view: viewOf(giveaway),
    entrantCount,
    requirements,
    multipliers,
    accentColor: ctx.config.embedColor,
    pausedBy: giveaway.pausedBy,
    pauseReason: giveaway.pauseReason,
  });

  if (!rendered.ok) {
    ctx.logger.error(
      `the giveaway message for '${giveaway.id}' could not be rebuilt, so its live count is ` +
        `stale: ${rendered.humanReason}`,
      { guildId: ctx.guildId, giveawayId: giveaway.id },
    );
    return false;
  }

  const result = await editGiveaway(ctx, {
    channelId: giveaway.channelId,
    messageId: giveaway.messageId,
    actorId: giveaway.hostId,
    components: rendered.components,
    idempotencyKey,
  });

  return result.status === 'executed';
}

export interface PublishInput {
  giveaway: Giveaway;
  summary: DrawSummary;
  reroll?: boolean;
  replacedIds?: readonly string[];
}

export async function publishResult(
  ctx: Ctx,
  deps: PublishDeps,
  input: PublishInput,
): Promise<void> {
  const { giveaway, summary } = input;
  const view = viewOf(giveaway);
  const root = `${giveaway.guildId}:${giveaway.id}:${summary.drawNumber}`;

  const { requirements, multipliers } = await describeBoth(deps, giveaway);
  const prizeLabel = describePrizes(parsePrizes(giveaway.prizes), giveaway.title);

  // A reroll repaints too: leaving the first winners standing on the message while a different
  // set is announced below it is the single most confusing thing this module can do.
  if (giveaway.messageId !== null) {
    const card = input.reroll
      ? summary.winnerIds.length === 0
        ? 'no-winners'
        : 'rerolled'
      : cardFor('ended', summary.winnerIds);

    const rendered = renderCard(card, {
      view,
      entrantCount: summary.entrantCount,
      requirements,
      multipliers,
      accentColor: ctx.config.embedColor,
      winnerIds: summary.winnerIds,
    });

    if (rendered.ok) {
      await editGiveaway(ctx, {
        channelId: giveaway.channelId,
        messageId: giveaway.messageId,
        actorId: giveaway.hostId,
        components: rendered.components,
        idempotencyKey: `giveaways:${root}:edit`,
      });
    }
  }

  await publishDrawn(ctx, deps.store, giveaway, summary, {
    ...(input.reroll ? { reroll: true } : {}),
    ...(input.replacedIds ? { replacedIds: input.replacedIds } : {}),
  });

  await recordDrawCase(ctx, {
    giveawayId: giveaway.id,
    actorId: summary.drawId,
    reason: `Giveaway "${giveaway.title}" draw ${summary.drawNumber}`,
    payload: {
      giveawayId: giveaway.id,
      drawNumber: summary.drawNumber,
      seed: summary.seed,
      snapshotHash: summary.snapshotHash,
      entrantCount: summary.entrantCount,
      totalEntries: summary.totalEntries,
      winnerIds: summary.winnerIds,
      degradedProviders: summary.degraded,
      disqualified: summary.disqualified,
    },
    idempotencyKey: `giveaways:${root}:case`,
  });

  if (ctx.config.announceInChannel) {
    const link =
      giveaway.messageId === null
        ? ''
        : `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`;

    const claim =
      giveaway.claimWindowSeconds && summary.winnerIds.length > 0
        ? claimRow(giveaway.id, summary.drawNumber)
        : null;

    await announceWinners(ctx, {
      channelId: giveaway.channelId,
      actorId: giveaway.hostId,
      content: input.reroll
        ? rerollAnnouncement(view, summary.winnerIds, link, prizeLabel)
        : announcement(view, summary.winnerIds, link, prizeLabel),
      ping: summary.winnerIds,
      ...(claim?.ok ? { components: claim.components } : {}),
      idempotencyKey: `giveaways:${root}:announce`,
    });
  }

  // Reward roles before the DM: a winner reading "you won" should already have the role, and a
  // hierarchy refusal has to reach the host rather than sitting in a warn log nobody opens.
  if (giveaway.rewardRoleId !== null && summary.winnerIds.length > 0) {
    const refusals: string[] = [];

    for (const userId of summary.winnerIds) {
      const granted = await grantRewardRole(
        ctx,
        userId,
        giveaway.rewardRoleId,
        `giveaways:${root}:reward:${userId}`,
      );

      if (!granted.ok) refusals.push(`<@${userId}> — ${granted.humanReason}`);
    }

    if (refusals.length > 0 && ctx.config.logChannelId) {
      await notifyHost(
        ctx,
        ctx.config.logChannelId,
        giveaway.hostId,
        `<@${giveaway.hostId}> — I could not give the reward role for **${giveaway.title}** ` +
          `to ${refusals.length === 1 ? 'a winner' : 'some winners'}:\n` +
          refusals.map((line) => `• ${line}`).join('\n') +
          '\nI need Manage Roles, and my own highest role has to sit above the reward role.',
        `giveaways:${root}:reward-failed`,
      );
    }
  }

  // A member with DMs closed is skipped rather than retried: the channel announcement is the
  // delivery everybody can see, and the DM is the courtesy on top of it.
  if (giveaway.dmWinners && summary.winnerIds.length > 0) {
    const link =
      giveaway.messageId === null
        ? ''
        : ` ${`https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`}`;

    // Per winner, so a multi-prize giveaway tells each of them what they actually won.
    const prizes = prizesForWinners(
      parsePrizes(giveaway.prizes),
      summary.winnerIds.length,
      giveaway.title,
    );

    let closed = 0;
    for (const [index, userId] of summary.winnerIds.entries()) {
      const won = prizes[index] ?? giveaway.title;

      const outcome = await dmWinner(
        ctx,
        userId,
        giveaway.winMessage ?? `You won **${won}**! Congratulations.${link}`,
        `giveaways:${root}:${userId}`,
      );

      if (outcome !== 'sent') closed += 1;
    }

    if (closed > 0) {
      ctx.logger.info(
        `${closed} of ${summary.winnerIds.length} winner(s) of '${giveaway.title}' could not be ` +
          'sent a direct message — their DMs are closed. They were announced in the channel.',
        { guildId: ctx.guildId, giveawayId: giveaway.id },
      );
    }
  }

  // Never silent: a draw that ran without one of its requirements is a different draw than the
  // one the host configured, and they are the only person who can decide whether to rerun it.
  if (summary.degraded.length > 0 && ctx.config.logChannelId) {
    await notifyHost(
      ctx,
      ctx.config.logChannelId,
      giveaway.hostId,
      `<@${giveaway.hostId}> — **${giveaway.title}** was drawn without ` +
        `${summary.degraded.length === 1 ? 'one of its requirements' : 'some of its requirements'}: ` +
        `${summary.degraded.join(', ')}. The module that owns ` +
        `${summary.degraded.length === 1 ? 'it' : 'them'} is switched off or not running, so ` +
        `${summary.degraded.length === 1 ? 'it was' : 'they were'} skipped rather than failing ` +
        'the draw. Rerun it with `/giveaway reroll` if that changes who should have won.',
      `giveaways:${root}:degraded`,
    );
  }
}
