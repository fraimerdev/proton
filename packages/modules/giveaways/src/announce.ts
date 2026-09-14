import { describeMultipliers, describeRequirements, type ProviderRegistry } from '@proton/core';
import {
  type BotFacts,
  type PlaceholderEnvironment,
  PROTON_SUPPORT_URL,
  type ServerFacts,
} from '@proton/core/placeholders';
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
import { type GiveawayWinFacts, renderWinMessage, winMessageKeys } from './placeholders.ts';
import { describePrizes, parsePrizes, prizesForWinners } from './prizes.ts';
import type { Giveaway, GiveawayStore } from './store.ts';

export interface PublishDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
  placeholders?: PlaceholderEnvironment;
}

interface WinMessageSources {
  template: string;
  now: number;
  endedAt: Date;
  server: ServerFacts | null;
  bot: BotFacts | null;
  deadlines: ReadonlyMap<string, Date | null> | null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readServer(
  ctx: Ctx,
  env: PlaceholderEnvironment | undefined,
  giveaway: Giveaway,
): Promise<ServerFacts | null> {
  if (!env) return null;

  try {
    return await env.server(giveaway.guildId);
  } catch (error) {
    ctx.logger.warn(
      `Proton could not read this server's details, so the server placeholders in the winner ` +
        `message for '${giveaway.title}' render as nothing: ${reasonOf(error)}`,
      { guildId: ctx.guildId, giveawayId: giveaway.id },
    );
    return { id: giveaway.guildId };
  }
}

async function readBot(
  ctx: Ctx,
  env: PlaceholderEnvironment | undefined,
  giveaway: Giveaway,
): Promise<BotFacts | null> {
  if (!env) return null;

  try {
    return await env.bot();
  } catch (error) {
    ctx.logger.warn(
      `Proton could not read its own profile, so its name and avatar render as nothing in the ` +
        `winner message for '${giveaway.title}': ${reasonOf(error)}`,
      { guildId: ctx.guildId, giveawayId: giveaway.id },
    );
    return { id: env.applicationId, name: null, supportUrl: PROTON_SUPPORT_URL };
  }
}

async function readDeadlines(
  ctx: Ctx,
  store: GiveawayStore,
  giveaway: Giveaway,
  drawId: string,
): Promise<ReadonlyMap<string, Date | null> | null> {
  try {
    const wins = await store.winners(giveaway.id);
    return new Map(
      wins
        .filter((win) => win.drawId === drawId)
        .map((win): [string, Date | null] => [win.userId, win.claimDeadline]),
    );
  } catch (error) {
    ctx.logger.warn(
      `The claim deadlines for '${giveaway.title}' could not be read, so ` +
        `{giveaway.claim_deadline} renders as nothing in its winner message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, giveawayId: giveaway.id },
    );
    return null;
  }
}

async function winMessageSources(
  ctx: Ctx,
  deps: PublishDeps,
  input: PublishInput,
  template: string,
): Promise<WinMessageSources> {
  const { giveaway, summary } = input;
  const keys = [...winMessageKeys(template)];
  const env = deps.placeholders;

  const [server, bot, deadlines] = await Promise.all([
    keys.some((key) => key.startsWith('server.')) ? readServer(ctx, env, giveaway) : null,
    keys.some((key) => key.startsWith('bot.')) ? readBot(ctx, env, giveaway) : null,
    giveaway.claimWindowSeconds && keys.includes('giveaway.claim_deadline')
      ? readDeadlines(ctx, deps.store, giveaway, summary.drawId)
      : null,
  ]);

  const now = env?.now() ?? Date.now();

  // A reroll reopens the giveaway, which clears endedAt and leaves endsAt at the first deadline.
  const endedAt = input.reroll ? new Date(now) : (giveaway.endedAt ?? giveaway.endsAt);

  return { template, now, endedAt, server, bot, deadlines };
}

function winFacts(
  giveaway: Giveaway,
  summary: DrawSummary,
  sources: WinMessageSources,
  winner: { index: number; prize: string; userId: string },
): GiveawayWinFacts {
  return {
    giveaway: {
      title: giveaway.title,
      prize: winner.prize,
      winnerIndex: winner.index,
      winnerCount: summary.winnerIds.length,
      endsAt: sources.endedAt,
      messageUrl:
        giveaway.messageId === null
          ? null
          : `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`,
      hostId: giveaway.hostId,
      claimDeadline: giveaway.claimWindowSeconds ? sources.deadlines?.get(winner.userId) : null,
    },
    winner: { userId: winner.userId },
    server: sources.server,
    bot: sources.bot,
  };
}

function personalMessage(
  ctx: Ctx,
  giveaway: Giveaway,
  sources: WinMessageSources,
  facts: GiveawayWinFacts,
  standard: string,
): string {
  const rendered = renderWinMessage(sources.template, facts, sources.now);
  if (rendered.output.trim().length > 0) return rendered.output;

  const problems = rendered.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
  ctx.logger.warn(
    `The winner message for '${giveaway.title}' came out empty once its placeholders were ` +
      `filled in, so the default message was sent instead.${problems ? ` ${problems}` : ''}`,
    { guildId: ctx.guildId, giveawayId: giveaway.id },
  );
  return standard;
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

    const sources =
      giveaway.winMessage === null
        ? null
        : await winMessageSources(ctx, deps, input, giveaway.winMessage);

    let closed = 0;
    for (const [index, userId] of summary.winnerIds.entries()) {
      const won = prizes[index] ?? giveaway.title;
      const standard = `You won **${won}**! Congratulations.${link}`;

      const content =
        sources === null
          ? standard
          : personalMessage(
              ctx,
              giveaway,
              sources,
              winFacts(giveaway, summary, sources, { index, prize: won, userId }),
              standard,
            );

      const outcome = await dmWinner(ctx, userId, content, `giveaways:${root}:${userId}`);

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
