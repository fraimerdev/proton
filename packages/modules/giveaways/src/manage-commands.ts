import {
  type CommandContext,
  describeMultipliers,
  describeRequirements,
  errorStatus,
  labelOf,
  newId,
  successStatus,
} from '@proton/core';
import { canManage, refuseManage } from './authorize.ts';
import {
  BONUS_LIST_MAX,
  type GiveawaysConfig,
  HISTORY_MAX,
  MESSAGE_CONTENT_MAX,
  parseGiveawayDuration,
  plural,
} from './config.ts';
import { bindDraw, clockOf, type GiveawaysDeps } from './deps.ts';
import { publishBonus } from './events.ts';
import {
  EDITABLE,
  editGiveawayFields,
  type ManageDeps,
  type ManageOutcome,
  pauseGiveaway,
  resumeGiveaway,
  type ShiftOutcome,
  shiftDeadline,
} from './manage.ts';
import {
  acknowledgeCommand,
  acknowledgeToggleable,
  type CommandAnswer,
  NOT_WIRED,
  reply,
} from './perform.ts';
import {
  ENTRANT_PAGE_SIZE,
  EXPORT_ROW_MAX,
  entrantPage,
  exportEntrants,
  renderStats,
} from './reports.ts';
import { formatShortCode } from './short-code.ts';
import {
  BONUS_MAX,
  BONUS_MIN,
  type Giveaway,
  type GiveawayPatch,
  type GiveawayStatus,
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

const NOT_FOUND = 'Couldn’t find a giveaway with that ID or code in this server.';

/** Resolves the giveaway the command names, then checks the invoker may act on it. */
async function target(
  ctx: Ctx,
  store: GiveawayStore,
): Promise<{ giveaway: Giveaway } | { refusal: string }> {
  const giveaway = await store.resolve(ctx.guildId, ctx.options.getString('giveaway') ?? '');

  if (!giveaway) return { refusal: NOT_FOUND };
  if (!canManage(ctx.config, actorOf(ctx), giveaway)) return { refusal: refuseManage(giveaway) };

  return { giveaway };
}

const STATE_WORDS: Record<GiveawayStatus, string> = {
  scheduled: 'hasn’t started yet',
  running: 'is already running',
  paused: 'is already paused',
  drawing: 'is being drawn right now',
  ended: 'has already ended',
  cancelled: 'was cancelled',
};

function describeManage(ctx: Ctx, outcome: ManageOutcome | ShiftOutcome, verb: string): string {
  switch (outcome.outcome) {
    case 'missing':
      return NOT_FOUND;

    case 'wrong-state': {
      const { status, title } = outcome.giveaway;
      const already =
        (status === 'paused' && verb === 'paused') || (status === 'running' && verb === 'resumed');

      return already
        ? `**${title}** ${STATE_WORDS[status]}.`
        : `**${title}** ${STATE_WORDS[status]}, so it can’t be ${verb}.`;
    }

    case 'too-short':
      return (
        `That would move the end of **${outcome.giveaway.title}** into the past. To draw it ` +
        `now, use \`${labelOf(ctx, 'giveaway', 'end')}\`.`
      );

    case 'ok':
      return '';
  }
}

async function refuse(ctx: Ctx, text: string): Promise<void> {
  await reply(ctx, errorStatus(text), { ephemeral: true });
}

async function settle(
  ctx: Ctx,
  answer: CommandAnswer,
  outcome: ManageOutcome | ShiftOutcome,
  verb: string,
  confirmation: (giveaway: Giveaway) => string,
): Promise<void> {
  if (outcome.outcome === 'ok') {
    await answer.answer(successStatus(confirmation(outcome.giveaway)));
    return;
  }

  await answer.refuse(errorStatus(describeManage(ctx, outcome, verb)));
}

export async function pauseCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await refuse(ctx, found.refusal);
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await refuse(ctx, NOT_WIRED);
    return;
  }

  const { giveaway } = found;
  if (giveaway.status !== 'running') {
    await refuse(ctx, describeManage(ctx, { outcome: 'wrong-state', giveaway }, 'paused'));
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'pause');

  const outcome = await pauseGiveaway(ctx, manage, {
    giveawayId: giveaway.id,
    by: ctx.userId,
    reason: ctx.options.getString('reason'),
  });

  await settle(
    ctx,
    answer,
    outcome,
    'paused',
    (paused) =>
      `**${paused.title}** has been paused. Nobody can enter until you resume it, and its ` +
      'time left is kept.',
  );
}

export async function resumeCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await refuse(ctx, found.refusal);
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await refuse(ctx, NOT_WIRED);
    return;
  }

  const { giveaway } = found;
  if (giveaway.status !== 'paused') {
    await refuse(ctx, describeManage(ctx, { outcome: 'wrong-state', giveaway }, 'resumed'));
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'resume');

  const outcome = await resumeGiveaway(ctx, manage, {
    giveawayId: giveaway.id,
    by: ctx.userId,
  });

  await settle(
    ctx,
    answer,
    outcome,
    'resumed',
    (resumed) => `**${resumed.title}** is running again and ends <t:${seconds(resumed.endsAt)}:R>.`,
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
    await refuse(ctx, duration.humanReason);
    return;
  }

  const found = await target(ctx, store);
  if ('refusal' in found) {
    await refuse(ctx, found.refusal);
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await refuse(ctx, NOT_WIRED);
    return;
  }

  const verb = direction === 1 ? 'extended' : 'shortened';
  const byMs = duration.ms * direction;
  const { giveaway } = found;

  if (giveaway.endsAt.getTime() + byMs <= clockOf(deps)()) {
    await refuse(ctx, describeManage(ctx, { outcome: 'too-short', giveaway }, verb));
    return;
  }

  if (!EDITABLE.includes(giveaway.status)) {
    await refuse(ctx, describeManage(ctx, { outcome: 'wrong-state', giveaway }, verb));
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, direction === 1 ? 'extend' : 'shorten');

  const outcome = await shiftDeadline(ctx, manage, {
    giveawayId: giveaway.id,
    byMs,
    by: ctx.userId,
  });

  await settle(
    ctx,
    answer,
    outcome,
    verb,
    (shifted) => `**${shifted.title}** now ends <t:${seconds(shifted.endsAt)}:R>.`,
  );
}

export async function editCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await refuse(ctx, found.refusal);
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
    await refuse(ctx, 'Choose at least one thing to change.');
    return;
  }

  const manage = manageDeps(deps);
  if (!manage) {
    await refuse(ctx, NOT_WIRED);
    return;
  }

  const { giveaway } = found;
  if (!EDITABLE.includes(giveaway.status)) {
    await refuse(ctx, describeManage(ctx, { outcome: 'wrong-state', giveaway }, 'edited'));
    return;
  }

  const answer = await acknowledgeToggleable(ctx, deps, 'edit');

  const outcome = await editGiveawayFields(ctx, manage, {
    giveawayId: giveaway.id,
    patch,
    by: ctx.userId,
  });

  await settle(ctx, answer, outcome, 'edited', (edited) => `**${edited.title}** has been updated.`);
}

export async function infoCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const giveaway = await store.resolve(ctx.guildId, ctx.options.getString('giveaway') ?? '');
  if (!giveaway) {
    await reply(ctx, errorStatus(NOT_FOUND), { ephemeral: true });
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
    `**${giveaway.title}** (\`${code}\`)`,
    `Status: **${giveaway.status}** · Channel: <#${giveaway.channelId}> · ` +
      `Host: <@${giveaway.hostId}>`,
    giveaway.startsAt === null ? '' : `Starts <t:${seconds(giveaway.startsAt)}:F>`,
    `${giveaway.endedAt === null ? 'Ends' : 'Ended'} ` +
      `<t:${seconds(giveaway.endedAt ?? giveaway.endsAt)}:F>`,
    `${plural(giveaway.winnerCount, 'winner')} · ${plural(entrants, 'entrant')}`,
    giveaway.pausedAt === null
      ? ''
      : `Paused by <@${giveaway.pausedBy ?? giveaway.hostId}>` +
        `${giveaway.pauseReason === null ? '' : `: ${giveaway.pauseReason}`}`,
    giveaway.maxEntriesPerUser === null
      ? ''
      : `Each member can have up to ${giveaway.maxEntriesPerUser} entries.`,
    requirements.length === 0
      ? 'No requirements, so anybody here can enter.'
      : `**Requirements** (${giveaway.requirementLogic === 'any' ? 'any one' : 'all'})\n` +
        bullets(requirements),
    multipliers.length === 0 ? '' : `**Bonus entries**\n${bullets(multipliers)}`,
    draws.length === 0 ? '' : `Drawn ${plural(draws.length, 'time')}.`,
    giveaway.messageId === null
      ? '_The giveaway message is missing._'
      : `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/` +
        `${giveaway.messageId}`,
  ];

  await reply(ctx, lines.filter((line) => line.length > 0).join('\n'), { ephemeral: true });
}

export async function bonusCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
  action: string,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, errorStatus(found.refusal), { ephemeral: true });
    return;
  }

  const { giveaway } = found;

  if (action === 'list') {
    const grants = await store.bonusGrants(giveaway.id);
    const live = grants.filter((grant) => grant.revokedAt === null);

    if (live.length === 0) {
      await reply(ctx, `Nobody has been given extra entries in **${giveaway.title}**.`, {
        ephemeral: true,
      });
      return;
    }

    const lines = live
      .slice(0, BONUS_LIST_MAX)
      .map(
        (grant) =>
          `• <@${grant.userId}>: **+${grant.amount}**` +
          `${grant.reason === null ? '' : ` · ${grant.reason}`}` +
          ` · by <@${grant.grantedBy}>`,
      );

    const more = live.length - lines.length;

    await reply(
      ctx,
      [`**Extra entries in ${giveaway.title}**`, ...lines, more > 0 ? `…and ${more} more.` : '']
        .filter((line) => line.length > 0)
        .join('\n'),
      { ephemeral: true },
    );
    return;
  }

  const userId = ctx.options.getUserId('member');
  if (userId === null) {
    await reply(
      ctx,
      errorStatus('Choose which member to give extra entries to or take them from.'),
      { ephemeral: true },
    );
    return;
  }

  if (action === 'remove') {
    const answer = await acknowledgeCommand(ctx, deps, { path: 'bonus.remove', ephemeral: true });
    const taken = await store.revokeBonus(giveaway.id, userId, ctx.userId, new Date());

    if (taken === 0) {
      await answer.refuse(
        errorStatus(`<@${userId}> has no extra entries in **${giveaway.title}** to take back.`),
      );
      return;
    }

    await publishBonus(ctx, store, giveaway, {
      actorId: ctx.userId,
      subjectId: userId,
      amount: taken,
      reason: null,
      revoked: true,
    });

    await answer.answer(
      successStatus(
        `Took back **${taken}** extra ${taken === 1 ? 'entry' : 'entries'} from ` +
          `<@${userId}> in **${giveaway.title}**.`,
      ),
    );
    return;
  }

  const amount = ctx.options.getInteger('entries');
  if (amount === null || amount < BONUS_MIN || amount > BONUS_MAX) {
    await reply(ctx, errorStatus(`Grant between ${BONUS_MIN} and ${BONUS_MAX} extra entries.`), {
      ephemeral: true,
    });
    return;
  }

  const answer = await acknowledgeCommand(ctx, deps, { path: 'bonus.add', ephemeral: true });

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

  await publishBonus(ctx, store, giveaway, {
    actorId: ctx.userId,
    subjectId: userId,
    amount: grant.amount,
    reason: grant.reason,
    revoked: false,
  });

  const entered = (await store.entry(giveaway.id, userId)) !== null;

  await answer.answer(
    successStatus(
      `<@${userId}> now has **+${grant.amount}** extra ` +
        `${grant.amount === 1 ? 'entry' : 'entries'} in **${giveaway.title}**` +
        `${grant.reason === null ? '' : ` (${grant.reason})`}.` +
        `${entered ? '' : ' They aren’t in the draw yet, so these count once they enter.'}`,
    ),
  );
}

export async function entrantsCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await refuse(ctx, found.refusal);
    return;
  }

  const { giveaway } = found;
  const answer = await acknowledgeCommand(ctx, deps, { path: 'entrants', ephemeral: true });
  const page = await entrantPage(store, giveaway.id, ctx.options.getInteger('page') ?? 1);

  if (page.total === 0) {
    await answer.answer(`Nobody has entered **${giveaway.title}** yet.`);
    return;
  }

  const start = (page.page - 1) * ENTRANT_PAGE_SIZE;
  const lines = page.rows.map(
    (row, index) =>
      `\`${String(start + index + 1).padStart(3)}.\` <@${row.userId}> · ` +
      `${plural(row.totalEntries, 'entry', 'entries')}`,
  );

  await answer.answer(
    [
      `**${giveaway.title}** · ${plural(page.total, 'entrant')}`,
      ...lines,
      page.pages > 1
        ? `Page ${page.page} of ${page.pages}. Use the page option to see the others.`
        : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export async function exportCommand(
  ctx: Ctx,
  deps: GiveawaysDeps,
  store: GiveawayStore,
): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await refuse(ctx, found.refusal);
    return;
  }

  const { giveaway } = found;
  const answer = await acknowledgeCommand(ctx, deps, { path: 'export', ephemeral: true });
  const exported = await exportEntrants(store, giveaway.id);

  if (exported.rows === 0) {
    await answer.refuse(
      errorStatus(`Nobody has entered **${giveaway.title}**, so there’s nothing to export.`),
    );
    return;
  }

  const code = formatShortCode(giveaway.shortCode) ?? giveaway.id;

  await answer.answer(
    successStatus(
      `Exported ${plural(exported.rows, 'entrant')} from **${giveaway.title}**.` +
        (exported.truncated
          ? ` The file stops at ${EXPORT_ROW_MAX.toLocaleString('en-GB')} rows, so it isn’t the ` +
            'whole list.'
          : ''),
    ),
    {
      filename: `giveaway-${code}-entrants.csv`,
      contentType: 'text/csv',
      data: new TextEncoder().encode(exported.csv),
    },
  );
}

export async function statsCommand(ctx: Ctx, store: GiveawayStore): Promise<void> {
  await reply(ctx, renderStats(await store.stats(ctx.guildId), ctx), { ephemeral: true });
}

const HISTORY_WORDS: Record<string, string> = {
  created: 'created',
  started: 'started',
  edited: 'edited',
  extended: 'extended',
  shortened: 'shortened',
  paused: 'paused',
  resumed: 'resumed',
  cancelled: 'cancelled',
  drawn: 'drawn',
  rerolled: 'rerolled',
  'bonus-granted': 'extra entries given',
  'bonus-revoked': 'extra entries taken back',
  claimed: 'claimed',
  forfeited: 'forfeited',
  orphaned: 'message deleted',
};

const AUTOMATIC_WHY: Record<string, string> = {
  'proton:claim-expiry': ' because a winner didn’t claim in time',
};

export async function historyCommand(ctx: Ctx, store: GiveawayStore): Promise<void> {
  const found = await target(ctx, store);
  if ('refusal' in found) {
    await reply(ctx, errorStatus(found.refusal), { ephemeral: true });
    return;
  }

  const { giveaway } = found;
  const events = await store.history(giveaway.id, HISTORY_MAX);

  if (events.length === 0) {
    await reply(
      ctx,
      `**${giveaway.title}** has no recorded history. Giveaways started before history was ` +
        'added don’t have any.',
      { ephemeral: true },
    );
    return;
  }

  const lines = events.map((event) => {
    const what = HISTORY_WORDS[event.kind] ?? event.kind;
    const who = event.actorId.startsWith('proton:')
      ? (AUTOMATIC_WHY[event.actorId] ?? '')
      : ` by <@${event.actorId}>`;

    return `<t:${Math.floor(event.at.getTime() / 1000)}:f> · ${what}${who}`;
  });

  await reply(
    ctx,
    [`**History of ${giveaway.title}**`, ...lines].join('\n').slice(0, MESSAGE_CONTENT_MAX),
    { ephemeral: true },
  );
}
