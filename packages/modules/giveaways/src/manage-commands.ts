import {
  type CommandContext,
  describeMultipliers,
  describeRequirements,
  newId,
} from '@proton/core';
import { canManage, refuseManage } from './authorize.ts';
import { BONUS_LIST_MAX, type GiveawaysConfig, parseGiveawayDuration, plural } from './config.ts';
import { bindDraw, type GiveawaysDeps } from './deps.ts';
import {
  editGiveawayFields,
  type ManageDeps,
  type ManageOutcome,
  pauseGiveaway,
  resumeGiveaway,
  type ShiftOutcome,
  shiftDeadline,
} from './manage.ts';
import { NOT_WIRED, reply } from './perform.ts';
import { formatShortCode } from './short-code.ts';
import {
  BONUS_MAX,
  BONUS_MIN,
  type Giveaway,
  type GiveawayPatch,
  type GiveawayStore,
} from './store.ts';

type Ctx = CommandContext<GiveawaysConfig>;

function seconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

function actorOf(ctx: Ctx): { userId: string; roleIds?: readonly string[] } {
  return { userId: ctx.userId, ...(ctx.actorRoleIds ? { roleIds: ctx.actorRoleIds } : {}) };
}

function manageDeps(deps: GiveawaysDeps): ManageDeps | null {
  const bound = bindDraw(deps);
  if ('unbound' in bound) return null;

  return {
    store: bound.bound.store,
    providers: bound.bound.providers,
    ...(deps.now ? { now: deps.now } : {}),
  };
}

/** Resolves the giveaway the command names, then checks the invoker may act on it. */
async function target(
  ctx: Ctx,
  store: GiveawayStore,
): Promise<{ giveaway: Giveaway } | { refusal: string }> {
  const giveaway = await store.resolve(ctx.guildId, ctx.options.getString('giveaway') ?? '');

  if (!giveaway) return { refusal: 'There is no giveaway here with that id or code.' };
  if (!canManage(ctx.config, actorOf(ctx), giveaway)) return { refusal: refuseManage(giveaway) };

  return { giveaway };
}

function describeManage(outcome: ManageOutcome | ShiftOutcome, verb: string): string {
  switch (outcome.outcome) {
    case 'missing':
      return 'There is no giveaway here with that id or code.';

    case 'wrong-state':
      return (
        `**${outcome.giveaway.title}** is ${outcome.giveaway.status}, so it cannot be ${verb}. ` +
        'Run `/giveaway info` to see where it actually is.'
      );

    case 'too-short':
      return (
        `That would put **${outcome.giveaway.title}** in the past. Use ` +
        '`/giveaway end` if you want to draw it now.'
      );

    case 'ok':
      return '';
  }
}

export async function pauseCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, found.refusal);
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await reply(ctx, NOT_WIRED);
    return;
  }

  const outcome = await pauseGiveaway(ctx, manage, {
    giveawayId: found.giveaway.id,
    by: ctx.userId,
    reason: ctx.options.getString('reason'),
  });

  await reply(
    ctx,
    outcome.outcome === 'ok'
      ? `**${outcome.giveaway.title}** is paused. Nobody can enter until you resume it, and the ` +
          'time it has left is held where it is.'
      : describeManage(outcome, 'paused'),
  );
}

export async function resumeCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, found.refusal);
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await reply(ctx, NOT_WIRED);
    return;
  }

  const outcome = await resumeGiveaway(ctx, manage, { giveawayId: found.giveaway.id });

  await reply(
    ctx,
    outcome.outcome === 'ok'
      ? `**${outcome.giveaway.title}** is running again — drawn ` +
          `<t:${seconds(outcome.giveaway.endsAt)}:R>.`
      : describeManage(outcome, 'resumed'),
  );
}

export async function shiftCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
  direction: 1 | -1,
): Promise<void> {
  const duration = parseGiveawayDuration(ctx.options.getString('duration') ?? '');
  if (!duration.ok) {
    await reply(ctx, duration.humanReason);
    return;
  }

  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, found.refusal);
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await reply(ctx, NOT_WIRED);
    return;
  }

  const outcome = await shiftDeadline(ctx, manage, {
    giveawayId: found.giveaway.id,
    byMs: duration.ms * direction,
  });

  await reply(
    ctx,
    outcome.outcome === 'ok'
      ? `**${outcome.giveaway.title}** now ends <t:${seconds(outcome.giveaway.endsAt)}:R>.`
      : describeManage(outcome, direction === 1 ? 'extended' : 'shortened'),
  );
}

export async function editCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, found.refusal);
    return;
  }

  const image = ctx.options.getString('image');
  const prize = ctx.options.getString('prize');
  const description = ctx.options.getString('description');
  const winners = ctx.options.getInteger('winners');
  const colour = ctx.options.getInteger('colour');

  const patch: GiveawayPatch = {
    ...(prize ? { title: prize } : {}),
    ...(description === null ? {} : { description }),
    ...(winners === null ? {} : { winnerCount: winners }),
    ...(colour === null ? {} : { color: colour }),
    // "none" is the only way a slash option can say "clear this" — an omitted option and one set
    // to an empty string arrive here identically.
    ...(image === null ? {} : { bannerUrl: image.toLowerCase() === 'none' ? null : image }),
  };

  if (Object.keys(patch).length === 0) {
    await reply(ctx, 'Name at least one thing to change.');
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await reply(ctx, NOT_WIRED);
    return;
  }

  const outcome = await editGiveawayFields(ctx, manage, {
    giveawayId: found.giveaway.id,
    patch,
  });

  await reply(
    ctx,
    outcome.outcome === 'ok'
      ? `**${outcome.giveaway.title}** updated, and the giveaway message with it.`
      : describeManage(outcome, 'edited'),
  );
}

export async function infoCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const giveaway = await store.resolve(ctx.guildId, ctx.options.getString('giveaway') ?? '');
  if (!giveaway) {
    await reply(ctx, 'There is no giveaway here with that id or code.');
    return;
  }

  const bound = bindDraw(deps);
  const [entrants, requirementRows, multiplierRows, draws] = await Promise.all([
    store.entrantCount(giveaway.id),
    store.requirements(giveaway.id),
    store.multipliers(giveaway.id),
    store.draws(giveaway.id),
  ]);

  const requirements =
    'bound' in bound
      ? describeRequirements(
          bound.bound.providers,
          requirementRows.map((row) => ({ providerId: row.providerId, config: row.config })),
        )
      : [];

  const multipliers =
    'bound' in bound
      ? describeMultipliers(
          bound.bound.providers,
          multiplierRows.map((row) => ({
            providerId: row.providerId,
            config: row.config,
            mode: row.mode,
          })),
        )
      : [];

  const code = formatShortCode(giveaway.shortCode) ?? giveaway.id;
  const bullets = (lines: readonly string[]): string => lines.map((line) => `• ${line}`).join('\n');

  const lines = [
    `**${giveaway.title}** — \`${code}\``,
    `Status: **${giveaway.status}** · Channel: <#${giveaway.channelId}> · ` +
      `Host: <@${giveaway.hostId}>`,
    giveaway.startsAt === null ? '' : `Starts <t:${seconds(giveaway.startsAt)}:F>`,
    `${giveaway.endedAt === null ? 'Ends' : 'Ended'} ` +
      `<t:${seconds(giveaway.endedAt ?? giveaway.endsAt)}:F>`,
    `${plural(giveaway.winnerCount, 'winner')} · ${plural(entrants, 'entrant')}`,
    giveaway.pausedAt === null
      ? ''
      : `Paused by <@${giveaway.pausedBy ?? giveaway.hostId}>` +
        `${giveaway.pauseReason === null ? '' : ` — ${giveaway.pauseReason}`}`,
    giveaway.maxEntriesPerUser === null
      ? ''
      : `Entries are capped at ${giveaway.maxEntriesPerUser} each.`,
    requirements.length === 0
      ? 'No requirements — anybody here can enter.'
      : `**Requirements** (${giveaway.requirementLogic})\n${bullets(requirements)}`,
    multipliers.length === 0 ? '' : `**Bonus entries**\n${bullets(multipliers)}`,
    draws.length === 0 ? '' : `Drawn ${plural(draws.length, 'time')}.`,
    giveaway.messageId === null
      ? '_The giveaway message is missing._'
      : `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/` +
        `${giveaway.messageId}`,
  ];

  await reply(ctx, lines.filter((line) => line.length > 0).join('\n'));
}

export async function bonusCommand(ctx: Ctx, store: GiveawayStore, action: string): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, found.refusal);
    return;
  }

  const { giveaway } = found;

  if (action === 'list') {
    const grants = await store.bonusGrants(giveaway.id);
    const live = grants.filter((grant) => grant.revokedAt === null);

    if (live.length === 0) {
      await reply(ctx, `Nobody has been granted extra entries in **${giveaway.title}**.`);
      return;
    }

    const lines = live
      .slice(0, BONUS_LIST_MAX)
      .map(
        (grant) =>
          `• <@${grant.userId}> — **+${grant.amount}**` +
          `${grant.reason === null ? '' : ` · ${grant.reason}`}` +
          ` · by <@${grant.grantedBy}>`,
      );

    const more = live.length - lines.length;

    await reply(
      ctx,
      [`**Extra entries — ${giveaway.title}**`, ...lines, more > 0 ? `…and ${more} more.` : '']
        .filter((line) => line.length > 0)
        .join('\n'),
    );
    return;
  }

  const userId = ctx.options.getUserId('member');
  if (userId === null) {
    await reply(ctx, 'Say which member.');
    return;
  }

  if (action === 'remove') {
    const taken = await store.revokeBonus(giveaway.id, userId, ctx.userId, new Date());

    await reply(
      ctx,
      taken === 0
        ? `<@${userId}> has no extra entries in **${giveaway.title}**.`
        : `Took back **${taken}** extra ${taken === 1 ? 'entry' : 'entries'} from <@${userId}>.`,
    );
    return;
  }

  const amount = ctx.options.getInteger('entries');
  if (amount === null || amount < BONUS_MIN || amount > BONUS_MAX) {
    await reply(ctx, `Grant between ${BONUS_MIN} and ${BONUS_MAX} extra entries.`);
    return;
  }

  // Granting to somebody who has not entered yet is deliberate and supported — the entry picks the
  // bonus up when they join.
  const grant = await store.grantBonus({
    id: newId(),
    giveawayId: giveaway.id,
    userId,
    amount,
    reason: ctx.options.getString('reason'),
    grantedBy: ctx.userId,
  });

  const entered = (await store.entry(giveaway.id, userId)) !== null;

  await reply(
    ctx,
    `<@${userId}> now has **+${grant.amount}** extra ${grant.amount === 1 ? 'entry' : 'entries'} ` +
      `in **${giveaway.title}**` +
      `${grant.reason === null ? '' : ` — ${grant.reason}`}.` +
      `${entered ? '' : ' They are not in the draw yet; it will count when they enter.'}`,
  );
}
