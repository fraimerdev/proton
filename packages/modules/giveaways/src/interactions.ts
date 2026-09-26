import {
  absentMemberContext,
  errorStatus,
  evaluateRequirement,
  interactionRef,
  memberContextFromGuildMember,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  snowflakeCreatedAt,
  successStatus,
} from '@proton/core';
import { MODULE_ID } from './config.ts';
import { bindEntry, clockOf, type GiveawaysDeps } from './deps.ts';
import { BLOCKED_FROM_GIVEAWAYS, describeJoin, isBlacklisted, join } from './entry.ts';
import { publishDropClaimed, publishEntered } from './events.ts';
import { inspectRequirements, renderMultipliers, renderRequirements } from './inspect.ts';
import {
  CLAIM_ACTION,
  COUNT_ACTION,
  ENTER_ACTION,
  LEAVE_ACTION,
  MULTIPLIERS_ACTION,
  REQUIREMENTS_ACTION,
} from './message.ts';
import { acknowledge, type Ctx, NOT_WIRED, refuseNow, tellEntrant } from './perform.ts';

export interface EnterId {
  action: string;
  giveawayId: string;
  drawNumber: number | null;
}

export function readEnterId(customId: string): EnterId | null {
  const parsed = parseCustomId(customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) return null;

  const giveawayId = parsed.args[0];
  if (giveawayId === undefined) return null;

  const drawNumber = parsed.args[1] === undefined ? null : Number.parseInt(parsed.args[1], 10);

  return {
    action: parsed.action,
    giveawayId,
    drawNumber: Number.isFinite(drawNumber) ? drawNumber : null,
  };
}

export type EnterOutcome = 'not-ours' | 'unbound' | 'missing' | 'answered' | 'ignored';

export async function handleEnter(
  event: ProtonEvent,
  ctx: Ctx,
  deps: GiveawaysDeps,
): Promise<EnterOutcome> {
  if (!ctx.config.enabled) return 'ignored';

  const interaction = readComponentInteraction(event);
  if (!interaction || interaction.guildId === null) return 'not-ours';

  const id = readEnterId(interaction.customId);
  if (!id) return 'not-ours';

  // The disabled count button cannot be pressed, but a stale message can still deliver one.
  if (id.action === COUNT_ACTION) return 'ignored';

  const HANDLED = [
    ENTER_ACTION,
    LEAVE_ACTION,
    CLAIM_ACTION,
    REQUIREMENTS_ACTION,
    MULTIPLIERS_ACTION,
  ];
  if (!HANDLED.includes(id.action)) return 'not-ours';

  const ref = interactionRef(interaction);
  const root = `${interaction.interactionId}:${id.action}`;

  // The press time, not the handling time: a press handled late must not undo a later one.
  const pressedAt = new Date(snowflakeCreatedAt(interaction.interactionId) ?? clockOf(deps)());

  const bound = bindEntry(deps);
  if ('unbound' in bound) {
    ctx.logger.error(
      `Giveaways cannot answer a button press: ${bound.unbound.join(', ')} is not bound.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await refuseNow(ctx, ref, interaction.userId, root, errorStatus(NOT_WIRED));
    return 'unbound';
  }

  const { store, providers, applicationId } = bound.bound;

  // Deferred first: everything below this line touches the database, and PLAN.md I9 gives three
  // seconds regardless of how many requirements a host configured.
  await acknowledge(ctx, ref, interaction.userId, root);

  const giveaway = await store.get(ctx.guildId, id.giveawayId);
  if (!giveaway) {
    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      errorStatus('That giveaway no longer exists.'),
    );
    return 'missing';
  }

  if (id.action === CLAIM_ACTION) {
    const draws = await store.draws(giveaway.id);
    const draw = draws.find((entry) => entry.drawNumber === (id.drawNumber ?? draws.length));

    const claimed = draw ? await store.claim(draw.id, interaction.userId, new Date()) : false;

    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      claimed
        ? successStatus(`You claimed **${giveaway.title}**. It’s yours.`)
        : errorStatus(
            'You can’t claim that prize. It isn’t yours, you’ve already claimed it, or the time ' +
              'to claim it has run out.',
          ),
    );

    return 'answered';
  }

  if (id.action === LEAVE_ACTION) {
    const left = await store.leave(giveaway.id, interaction.userId, pressedAt);
    if (left === 'left') await deps.dirty?.mark(giveaway.guildId, giveaway.id);

    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      left === 'left'
        ? successStatus(
            `You left **${giveaway.title}**. You can enter again while it’s still running.`,
          )
        : left === 'superseded'
          ? errorStatus(
              `You entered **${giveaway.title}** after pressing “Leave”, so you’re still in the draw.`,
            )
          : errorStatus(`You’re not in the draw for **${giveaway.title}**.`),
    );

    return 'answered';
  }

  const [requirementRows, multiplierRows, blacklist] = await Promise.all([
    store.requirements(giveaway.id),
    store.multipliers(giveaway.id),
    store.blacklist(ctx.guildId),
  ]);

  const now = new Date(clockOf(deps)());

  // The dispatch already carries the whole member — roles, join date, boost date, avatar — so a
  // join needs no member fetch at all. Five thousand joins a minute cost zero REST calls.
  const rawMember = (event.payload as { member?: unknown } | null)?.member;

  const memberCtx =
    memberContextFromGuildMember(ctx.guildId, rawMember, now, ctx.tier ?? 'free') ??
    absentMemberContext(ctx.guildId, interaction.userId, now, ctx.tier ?? 'free');

  if (!memberCtx) {
    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      errorStatus('I couldn’t tell who pressed that button. Try again in a moment.'),
    );
    return 'answered';
  }

  // A drop is decided at the press, not at a deadline: requirements are evaluated exactly as for a
  // normal entry, and the first member who clears them takes it.
  if (giveaway.entryMethod === 'drop' && id.action === ENTER_ACTION) {
    const verdict = await evaluateRequirement(
      providers,
      memberCtx,
      requirementRows.map((row) => ({ providerId: row.providerId, config: row.config })),
      giveaway.requirementLogic,
    );

    if (isBlacklisted(blacklist, interaction.userId, memberCtx.member?.roleIds ?? null)) {
      await tellEntrant(
        ctx,
        { applicationId, interaction: ref },
        interaction.userId,
        root,
        errorStatus(BLOCKED_FROM_GIVEAWAYS),
      );
      return 'answered';
    }

    if (!verdict.passed) {
      await tellEntrant(
        ctx,
        { applicationId, interaction: ref },
        interaction.userId,
        root,
        errorStatus(
          [
            `You can’t claim **${giveaway.title}**. Here’s what you’re missing:`,
            ...verdict.failures.map((failure) => `• ${failure.humanReason}`),
          ].join('\n'),
        ),
      );
      return 'answered';
    }

    const dropped = await store.claimDrop(ctx.guildId, giveaway.id, interaction.userId, now);

    // claimDrop only ever wins once, so a redelivered press by the winner comes back 'taken'. The
    // win row is what tells that apart from a loser, and it must publish again: the first publish
    // is what was lost.
    const replayed =
      dropped.outcome === 'taken' &&
      (await store.winners(giveaway.id)).some(
        (win) => win.drawId === `${giveaway.id}:drop` && win.userId === interaction.userId,
      );

    if (dropped.outcome === 'won' || replayed) {
      await publishDropClaimed(ctx, dropped.outcome === 'won' ? dropped.giveaway : giveaway, {
        userId: interaction.userId,
        activityAt: event.occurredAt,
      });
    }

    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      dropped.outcome === 'won' || replayed
        ? successStatus(`You claimed **${giveaway.title}**. It’s yours.`)
        : dropped.outcome === 'taken'
          ? errorStatus(`Somebody was faster. **${giveaway.title}** is already gone.`)
          : errorStatus('That giveaway no longer exists.'),
    );

    return 'answered';
  }

  const requirementSpecs = requirementRows.map((row) => ({
    providerId: row.providerId,
    config: row.config,
  }));
  const multiplierSpecs = multiplierRows.map((row) => ({
    providerId: row.providerId,
    config: row.config,
    mode: row.mode,
  }));

  if (id.action === REQUIREMENTS_ACTION) {
    const lines = await inspectRequirements(providers, memberCtx, requirementSpecs);

    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      renderRequirements(lines, giveaway.requirementLogic, giveaway.title),
    );

    return 'answered';
  }

  if (id.action === MULTIPLIERS_ACTION) {
    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      root,
      await renderMultipliers(
        providers,
        memberCtx,
        multiplierSpecs,
        giveaway.title,
        giveaway.maxEntriesPerUser,
      ),
    );

    return 'answered';
  }

  const outcome = await join(
    { store, providers, ...(deps.bucket ? { bucket: deps.bucket } : {}) },
    {
      giveaway,
      ctx: memberCtx,
      pressedAt,
      requirements: requirementSpecs,
      multipliers: multiplierSpecs,
      blacklist,
      blacklistRoleIds: ctx.config.blacklistRoleIds,
      bypassRoleIds: ctx.config.bypassRoleIds,
    },
  );

  // Already-entered too: a press redelivered after the first publish was lost lands there.
  if (outcome.outcome === 'entered' || outcome.outcome === 'already-entered') {
    await publishEntered(ctx, giveaway, {
      userId: interaction.userId,
      totalEntries: outcome.totalEntries,
      activityAt: event.occurredAt,
    });
  }

  if (outcome.outcome === 'entered') {
    // Marked, not edited: the debounced updater turns thousands of joins into a handful of edits.
    await deps.dirty?.mark(giveaway.guildId, giveaway.id);
  }

  const joined = describeJoin(outcome, giveaway.title);

  await tellEntrant(
    ctx,
    { applicationId, interaction: ref },
    interaction.userId,
    root,
    outcome.outcome === 'entered' ? successStatus(joined) : errorStatus(joined),
  );

  return 'answered';
}
