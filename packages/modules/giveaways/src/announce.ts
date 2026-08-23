import { describeMultipliers, describeRequirements, type ProviderRegistry } from '@proton/core';
import type { DrawSummary } from './end.ts';
import {
  announcement,
  claimRow,
  endedMessage,
  rerollAnnouncement,
  runningMessage,
  viewOf,
} from './message.ts';
import {
  announceWinners,
  type Ctx,
  dmWinner,
  editGiveaway,
  notifyHost,
  recordDrawCase,
} from './perform.ts';
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

  const rendered = runningMessage({
    view: viewOf(giveaway),
    entrantCount,
    requirements,
    multipliers,
    accentColor: ctx.config.embedColor,
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

  if (giveaway.messageId !== null && !input.reroll) {
    const rendered = endedMessage({
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
        idempotencyKey: `${root}:edit`,
      });
    }
  }

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
        ? rerollAnnouncement(view, summary.winnerIds, link)
        : announcement(view, summary.winnerIds, link),
      ping: summary.winnerIds,
      ...(claim?.ok ? { components: claim.components } : {}),
      idempotencyKey: `giveaways:${root}:announce`,
    });
  }

  // A member with DMs closed is skipped rather than retried: the channel announcement is the
  // delivery everybody can see, and the DM is the courtesy on top of it.
  if (giveaway.dmWinners && summary.winnerIds.length > 0) {
    const link =
      giveaway.messageId === null
        ? ''
        : ` ${`https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`}`;

    let closed = 0;
    for (const userId of summary.winnerIds) {
      const outcome = await dmWinner(
        ctx,
        userId,
        giveaway.winMessage ?? `You won **${giveaway.title}**! Congratulations.${link}`,
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
