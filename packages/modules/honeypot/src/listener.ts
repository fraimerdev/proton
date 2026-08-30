import type {
  ActionResult,
  EventListener,
  EventType,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import {
  channelFor,
  describeWindow,
  HONEYPOT_ACTOR,
  type HoneypotChannel,
  type HoneypotConfig,
  MODULE_ID,
} from './config.ts';
import {
  type BoundHoneypotDeps,
  bindHoneypotDeps,
  describeUnbound,
  type HoneypotDeps,
} from './deps.ts';
import { appealUrlFor, DM_RESULT_LABEL, type DmOutcome, sendDirectMessage } from './dm.ts';
import { buildIncidentEmbed, type Incident, quoteForLog } from './embed.ts';
import { EXEMPT_LABEL, exemptReason, type HoneypotExemptReason } from './exempt.ts';
import { ignoreReason, readMessage, type TrapMessage } from './message.ts';
import { type Punishment, planTrap, type TrapPlan } from './plan.ts';
import { schedulePunishment } from './punish.ts';
import type { DmFacts } from './render.ts';
import { refreshNoticeCount } from './service.ts';
import { HONEYPOT_LOCK_TTL_MS } from './store.ts';

export const HONEYPOT_EVENT_TYPES: EventType[] = ['message.created'];

export function punishmentOf(config: HoneypotConfig): Punishment {
  return {
    action: config.action,
    deleteMessageSeconds: config.deleteMessageSeconds,
    timeoutDuration: config.timeoutDuration,
    timeoutFirst: config.timeoutFirst,
    timeoutFirstDuration: config.timeoutFirstDuration,
    deleteTriggerMessage: config.deleteTriggerMessage,
  };
}

export type TrapOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'exempt'; reason: HoneypotExemptReason }
  | { action: 'waiting'; runAt: number }
  | { action: 'held'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'sprung'; kind: string }
  | { action: 'ban_stuck'; userId: string };

function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export function createHoneypotListener(deps: HoneypotDeps): EventListener<HoneypotConfig> {
  return {
    types: HONEYPOT_EVENT_TYPES,
    async handler(event, ctx) {
      await handleMessage(event, ctx, deps);
    },
  };
}

export async function handleMessage(
  event: ProtonEvent,
  ctx: ModuleContext<HoneypotConfig>,
  rawDeps: HoneypotDeps,
): Promise<TrapOutcome> {
  if (!ctx.config.enabled) return { action: 'ignored', reason: 'honeypot is off in this server' };
  if (ctx.config.channels.length === 0) {
    return { action: 'ignored', reason: 'no honeypot channels are configured' };
  }

  const message = readMessage(event);
  if (!message) return { action: 'ignored', reason: 'unreadable message payload' };

  const bound = bindHoneypotDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound('a message in a honeypot channel was NOT acted on', bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'refused', reason: 'the honeypot ports are unbound' };
  }

  // One read, feeding both the thread's parent and the exemption check. Two would be two round
  // trips for one message.
  const state = rawDeps.guildState ? await rawDeps.guildState.get(ctx.guildId) : null;
  const parentId = state?.channels.get(message.channelId)?.parentId ?? null;

  const channel = channelFor(ctx.config, message.channelId, parentId);
  if (!channel) return { action: 'ignored', reason: 'not a honeypot channel' };

  const ignored = ignoreReason(message, bound.deps.botUserId);
  if (ignored) return { action: 'ignored', reason: ignored };

  // Claimed before anything else. A spam bot posts in every channel it can see, and three messages
  // a second apart must be one removal, not three.
  const won = await bound.deps.lock.claim(ctx.guildId, message.authorId, HONEYPOT_LOCK_TTL_MS);
  if (!won) {
    return { action: 'held', reason: 'this member already tripped a honeypot moments ago' };
  }

  // After the lock, so a burst of three from one exempt admin is one log line rather than three.
  const exempt = exemptReason({
    config: ctx.config,
    userId: message.authorId,
    roleIds: message.roleIds,
    state,
  });

  if (exempt) return excuse(ctx, bound.deps, rawDeps, channel, message, exempt);

  if (ctx.config.waitBeforeActingSeconds > 0) {
    const waited = await schedulePunishment(
      ctx,
      {
        channelId: message.channelId,
        messageId: message.messageId,
        userId: message.authorId,
        content: message.content,
        caughtAt: bound.deps.now(),
        punishment: punishmentOf(ctx.config),
      },
      ctx.config.waitBeforeActingSeconds,
    );

    // A deployment with no scheduler must still act rather than silently do nothing at all.
    if (waited.action === 'waiting') return waited;
  }

  return spring(ctx, bound.deps, rawDeps, channel, message);
}

/**
 * A catch Proton logs and counts but does nothing about. Deliberately not routed through spring():
 * nothing here reaches the executor, so reporting it as a refusal would put an amber "could not be
 * carried out" against an action that was never attempted.
 */
async function excuse(
  ctx: ModuleContext<HoneypotConfig>,
  deps: BoundHoneypotDeps,
  rawDeps: HoneypotDeps,
  channel: HoneypotChannel,
  message: TrapMessage,
  reason: HoneypotExemptReason,
): Promise<TrapOutcome> {
  ctx.logger.info(
    `${message.authorId} posted in honeypot channel ${message.channelId} and was left alone: ` +
      `${EXEMPT_LABEL[reason]}.`,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      channelId: message.channelId,
      userId: message.authorId,
    },
  );

  await report(
    ctx,
    deps,
    incidentOf(ctx, message, 'Nothing — they are exempt', 'exempt', EXEMPT_LABEL[reason]),
  );

  await count(ctx, rawDeps, channel, message, deps.now(), 'exempt');

  return { action: 'exempt', reason };
}

export async function spring(
  ctx: ModuleContext<HoneypotConfig>,
  deps: BoundHoneypotDeps,
  rawDeps: HoneypotDeps,
  channel: HoneypotChannel,
  message: TrapMessage,

  // Passed in rather than read from config, so a punishment booked behind a wait runs under the
  // settings it was booked with rather than whatever the guild has saved by the time it fires.
  punishment: Punishment = punishmentOf(ctx.config),
): Promise<TrapOutcome> {
  const planned = planTrap(punishment, message.authorId, deps.now());

  if ('unconfigured' in planned) {
    ctx.logger.error(planned.unconfigured, { guildId: ctx.guildId, moduleId: MODULE_ID });
    await report(
      ctx,
      deps,
      incidentOf(ctx, message, 'Misconfigured', 'refused', planned.unconfigured),
    );
    return { action: 'refused', reason: planned.unconfigured };
  }

  const { plan } = planned;
  const root = `${MODULE_ID}:${ctx.guildId}:${message.messageId}`;

  ctx.logger.warn(
    `${message.authorId} posted in honeypot channel ${message.channelId}: ${plan.describe}.`,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      channelId: message.channelId,
      messageId: message.messageId,
      userId: message.authorId,
    },
  );

  // Before the first step, not after. A ban leaves no shared server to send a direct message
  // through, so telling them afterwards is telling nobody.
  const told = await sendDirectMessage(
    ctx,
    rawDeps,
    message.authorId,
    root,
    {
      ...(await dmFacts(ctx, rawDeps)),

      // A real ban only. A softban bans and lifts it in the same breath, so an appeal button there
      // invites somebody to argue about something that is not stopping them.
      appealUrl: await appealUrlFor(
        ctx,
        rawDeps,
        message.authorId,
        root,
        deps.now(),
        punishment.action === 'ban',
      ),
    },
    ctx.tier,
  );

  let banned = false;
  let failure: string | null = null;

  // The executor already refused this step as a duplicate, which means this message sprang the trap
  // once before and was counted then. RESUME redelivers past the burst lock; this is what stops the
  // same member being added to a public number twice.
  let replayed = false;

  for (const step of plan.steps) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: step.kind,
      actorId: HONEYPOT_ACTOR,
      targetId: message.authorId,
      reason: ctx.config.auditLogReason,
      payload: step.payload,
      dryRun: false,

      // One trap is one case. The lift half of a softban is bookkeeping, not a second punishment.
      ...(step.kind === 'unban' ? { record: false } : {}),
      idempotencyKey: `${root}:${step.suffix}`,
    });

    if (succeeded(result)) {
      if (step.kind === 'ban') banned = true;
      if (result.status === 'skipped_duplicate') replayed = true;
      continue;
    }

    failure = result.failure?.humanReason ?? 'Discord refused it and gave no reason.';

    ctx.logger.error(`honeypot could not ${step.kind} ${message.authorId}: ${failure}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure?.code,
    });

    // The one failure that leaves the member worse off than before Proton acted.
    if (plan.softban && banned && step.kind === 'unban') {
      const stuck = await retryUnban(ctx, message.authorId, root);

      // The retry landed, so the softban completed. Leaving `failure` set would report a finished
      // softban as refused AND re-delete a message the ban's own window had already taken.
      if (!stuck) {
        failure = null;
        break;
      }

      ctx.logger.error(
        `honeypot banned ${message.authorId} in ${ctx.guildId} to purge their messages and could ` +
          `NOT lift it: ${stuck}. They are still banned and a moderator has to unban them by hand.`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId: message.authorId },
      );

      await report(ctx, deps, incidentOf(ctx, message, plan.describe, 'ban_stuck', stuck));
      await publish(ctx, message, plan, 'ban_stuck');

      return { action: 'ban_stuck', userId: message.authorId };
    }

    break;
  }

  await deleteTrigger(ctx, plan, message, root, failure !== null, punishment);

  const outcome = failure === null ? 'done' : 'refused';

  await report(ctx, deps, incidentOf(ctx, message, plan.describe, outcome, failure, told));
  await publish(ctx, message, plan, outcome);

  // Last, and after the audit trail rather than before it. A number on a button is cosmetic; a
  // throw out of Redis here used to take the incident log and the security event down with it.
  if (failure === null && !replayed) {
    await count(ctx, rawDeps, channel, message, deps.now());
    await blacklist(ctx, rawDeps, message, root);
  }

  return failure === null
    ? { action: 'sprung', kind: ctx.config.action }
    : { action: 'refused', reason: failure };
}

async function retryUnban(
  ctx: ModuleContext<HoneypotConfig>,
  userId: string,
  root: string,
): Promise<string | null> {
  const retry = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'unban',
    actorId: HONEYPOT_ACTOR,
    targetId: userId,
    reason: 'Honeypot: lifting the softban (retry).',
    payload: { userId },
    dryRun: false,
    record: false,
    idempotencyKey: `${root}:unban-retry`,
  });

  return succeeded(retry) ? null : (retry.failure?.humanReason ?? 'Discord refused it twice.');
}

async function deleteTrigger(
  ctx: ModuleContext<HoneypotConfig>,
  plan: TrapPlan,
  message: TrapMessage,
  root: string,
  banFailed: boolean,
  punishment: Punishment,
): Promise<void> {
  if (!punishment.deleteTriggerMessage) return;

  // A ban that landed took the message with it, and a second delete would race that purge — but a
  // ban that was refused purged nothing, so the message baiting the trap is still sitting there.
  if (plan.deletesMessages && !banFailed) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: HONEYPOT_ACTOR,
    reason: 'Honeypot: removing the message that sprang the trap.',
    payload: { channelId: message.channelId, messageId: message.messageId },
    dryRun: false,
    record: false,
    idempotencyKey: `${root}:delete`,
  });

  if (!succeeded(result)) {
    ctx.logger.warn(
      `honeypot could not delete the message that sprang it: ${
        result.failure?.humanReason ?? 'no reason was reported'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function dmFacts(ctx: ModuleContext<HoneypotConfig>, deps: HoneypotDeps): Promise<DmFacts> {
  return { guildName: (await deps.guildName?.(ctx.guildId)) ?? 'this server' };
}

function incidentOf(
  ctx: ModuleContext<HoneypotConfig>,
  message: TrapMessage,
  action: string,
  outcome: Incident['outcome'],
  detail: string | null,
  told?: DmOutcome,
): Incident {
  const quote = ctx.config.quoteMessage ? quoteForLog(message.content) : undefined;

  return {
    guildId: ctx.guildId,
    userId: message.authorId,
    channelId: message.channelId,
    messageId: message.messageId,
    action,
    window:
      ctx.config.action === 'softban' || ctx.config.action === 'ban'
        ? describeWindow(ctx.config.deleteMessageSeconds)
        : null,
    outcome,
    ...(detail ? { detail } : {}),
    ...(quote ? { quote } : {}),
    ...(told && told !== 'skipped' ? { dm: DM_RESULT_LABEL[told] } : {}),
  };
}

async function report(
  ctx: ModuleContext<HoneypotConfig>,
  deps: BoundHoneypotDeps,
  incident: Incident,
): Promise<void> {
  const channelId = ctx.config.logChannelId;
  if (!channelId) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: HONEYPOT_ACTOR,
    dryRun: false,
    record: false,
    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${incident.messageId}:log`,
    payload: {
      channelId,
      embeds: [buildIncidentEmbed(incident, deps.now())],
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `honeypot could not post its incident log to ${channelId}: ${
        result.failure?.humanReason ?? 'no reason was reported'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function publish(
  ctx: ModuleContext<HoneypotConfig>,
  message: TrapMessage,
  plan: TrapPlan,
  outcome: Incident['outcome'],
): Promise<void> {
  await ctx.publish?.('proton.security_tripped', message.messageId, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    trigger: 'honeypot',
    actorId: message.authorId,
    summary: `Posted in <#${message.channelId}>, which is a honeypot channel.`,
    actionsTaken:
      outcome === 'ban_stuck'
        ? [`${plan.describe} — the unban FAILED and the member is still banned`]
        : [plan.describe],
    ownerExempt: false,
  });
}

async function blacklist(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  message: TrapMessage,
  root: string,
): Promise<void> {
  if (!ctx.config.addToBlacklist) return;

  if (!deps.blocked) {
    ctx.logger.error(
      describeUnbound(`${message.authorId} was NOT added to the blocked list`, ['blocked']),
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: message.authorId },
    );
    return;
  }

  try {
    await deps.blocked.block({
      guildId: ctx.guildId,
      userId: message.authorId,
      moduleId: MODULE_ID,
      blockedBy: HONEYPOT_ACTOR,
      reason: ctx.config.auditLogReason,
      evidence: { channelId: message.channelId, messageId: message.messageId },

      // The trap root, so a redelivered message cannot block the same member twice.
      idempotencyKey: `${root}:block`,
    });
  } catch (error) {
    ctx.logger.error(
      `honeypot removed ${message.authorId} but could not add them to the blocked list: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: message.authorId },
    );
  }
}

async function count(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  channel: HoneypotChannel,
  message: TrapMessage,
  at: number,
  action: string = ctx.config.action,
): Promise<void> {
  try {
    await deps.stats?.record(ctx.guildId, channel.channelId, {
      messageId: message.messageId,
      userId: message.authorId,
      action,
      at,
    });

    await refreshNoticeCount(ctx, deps, channel.channelId, message.messageId);
  } catch (error) {
    ctx.logger.warn(
      `honeypot removed ${message.authorId} but could not move the count on the notice: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}
