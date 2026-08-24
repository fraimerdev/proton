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
import { buildIncidentEmbed, type Incident } from './embed.ts';
import { ignoreReason, readMessage, type TrapMessage } from './message.ts';
import { planTrap, type TrapPlan } from './plan.ts';
import { HONEYPOT_LOCK_TTL_MS } from './store.ts';

export const HONEYPOT_EVENT_TYPES: EventType[] = ['message.created'];

export const HONEYPOT_ACTOR = 'proton:honeypot';

export type TrapOutcome =
  | { action: 'ignored'; reason: string }
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

  const parentId = rawDeps.guildState
    ? ((await rawDeps.guildState.get(ctx.guildId))?.channels.get(message.channelId)?.parentId ??
      null)
    : null;

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

  return spring(ctx, bound.deps, channel, message);
}

async function spring(
  ctx: ModuleContext<HoneypotConfig>,
  deps: BoundHoneypotDeps,
  channel: HoneypotChannel,
  message: TrapMessage,
): Promise<TrapOutcome> {
  const planned = planTrap(channel, message.authorId, deps.now());

  if ('unconfigured' in planned) {
    ctx.logger.error(planned.unconfigured, { guildId: ctx.guildId, moduleId: MODULE_ID });
    await report(
      ctx,
      deps,
      incidentOf(ctx, channel, message, 'Misconfigured', 'refused', planned.unconfigured),
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

  let banned = false;
  let failure: string | null = null;

  for (const step of plan.steps) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: step.kind,
      actorId: HONEYPOT_ACTOR,
      targetId: message.authorId,
      reason: `Honeypot: posted in #${message.channelId}.`,
      payload: step.payload,
      dryRun: false,

      // One trap is one case. The lift half of a softban is bookkeeping, not a second punishment.
      ...(step.kind === 'unban' ? { record: false } : {}),
      idempotencyKey: `${root}:${step.suffix}`,
    });

    if (succeeded(result)) {
      if (step.kind === 'ban') banned = true;
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

      await report(ctx, deps, incidentOf(ctx, channel, message, plan.describe, 'ban_stuck', stuck));
      await publish(ctx, message, plan, 'ban_stuck');

      return { action: 'ban_stuck', userId: message.authorId };
    }

    break;
  }

  await deleteTrigger(ctx, plan, message, root, failure !== null);

  const outcome = failure === null ? 'done' : 'refused';
  await report(ctx, deps, incidentOf(ctx, channel, message, plan.describe, outcome, failure));
  await publish(ctx, message, plan, outcome);

  return failure === null
    ? { action: 'sprung', kind: channel.action }
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
): Promise<void> {
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

function incidentOf(
  ctx: ModuleContext<HoneypotConfig>,
  channel: HoneypotChannel,
  message: TrapMessage,
  action: string,
  outcome: Incident['outcome'],
  detail: string | null,
): Incident {
  return {
    guildId: ctx.guildId,
    userId: message.authorId,
    channelId: message.channelId,
    messageId: message.messageId,
    action,
    window:
      channel.action === 'softban' || channel.action === 'ban'
        ? describeWindow(channel.deleteMessageSeconds)
        : null,
    outcome,
    ...(detail ? { detail } : {}),
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
