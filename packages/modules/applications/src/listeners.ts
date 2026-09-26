import {
  applicationWorkRequestedSchema,
  type EventListener,
  type ModuleContext,
  type ProtonEvent,
  protonConfigChangedSchema,
  protonPanelRequestedSchema,
  ticketOpenAnsweredSchema,
  xpGrantedSchema,
} from '@proton/core';
import { type ApplicationsConfig, panelFor } from './config.ts';
import { MODULE_ID } from './constants.ts';
import {
  type ApplicationsDeps,
  type BoundApplicationsDeps,
  bindApplicationsDeps,
  describeUnbound,
} from './deps.ts';
import { XP_KEY } from './effects.ts';
import { sendPanel } from './panel.ts';
import { armSweep, publishActionFailed, refreshCard, runApplicationWork } from './runner.ts';
import type { EffectRecord, RequestAnswer } from './store.ts';
import { DAY_MS } from './web.ts';

type Ctx = ModuleContext<ApplicationsConfig>;

const XP_REFUSED = 'Leveling refused the XP reward.';
const TICKET_REFUSED = 'Tickets didn’t open the interview ticket.';
const REASON_MAX = 300;

export const INFO_GRACE_MS = DAY_MS;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bound(ctx: Ctx, deps: ApplicationsDeps, what: string): BoundApplicationsDeps | null {
  const binding = bindApplicationsDeps(deps);
  if ('deps' in binding) return binding.deps;

  ctx.logger.error(describeUnbound(what, binding.unbound), {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
  });
  return null;
}

function applicationOfGrant(guildId: string, grantId: string): string | null {
  const prefix = `${MODULE_ID}:${guildId}:`;
  const suffix = ':accepted';
  if (!grantId.startsWith(prefix) || !grantId.endsWith(suffix)) return null;

  const id = grantId.slice(prefix.length, grantId.length - suffix.length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

async function settled(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  effect: EffectRecord | null,
  shownOnCard: boolean,
): Promise<void> {
  if (effect === null) return;

  const failed = effect.status === 'failed';
  if (failed) await publishActionFailed(ctx, deps, effect);
  if (failed || (shownOnCard && effect.status === 'succeeded')) {
    await refreshCard(ctx, deps, effect.applicationId, `answer:${effect.id}:${effect.status}`);
  }
}

async function onPanelRequested(event: ProtonEvent, ctx: Ctx): Promise<void> {
  const asked = protonPanelRequestedSchema.safeParse(event.payload);
  if (!asked.success || asked.data.moduleId !== MODULE_ID) return;

  if (!ctx.config.enabled) {
    ctx.logger.warn(
      'applications was asked to post a panel while it is off, so it posted nothing',
      { guildId: ctx.guildId, moduleId: MODULE_ID, panelId: asked.data.panelId },
    );
    return;
  }

  const panel = panelFor(ctx.config, asked.data.panelId);
  if (panel === undefined) {
    ctx.logger.warn(
      `applications was asked to post '${asked.data.panelId}', which is not a panel`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const posted = await sendPanel(ctx, panel, {
    actorId: asked.data.actorId,
    idempotencyKey: asked.data.auditId,
  });
  if (posted.ok) return;

  ctx.logger.error(`applications could not post the panel '${panel.id}': ${posted.humanReason}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
  });
}

async function onConfigChanged(event: ProtonEvent, ctx: Ctx, deps: ApplicationsDeps) {
  const change = protonConfigChangedSchema.safeParse(event.payload);
  if (!change.success || change.data.moduleId !== MODULE_ID) return;

  if (change.data.changedKeys.includes('retentionDays')) {
    const ready = bound(ctx, deps, 'the new keep-for period was not applied');
    if (ready !== null) {
      await ready.store.rescheduleRetention(ctx.guildId, ctx.config.retentionDays);
    }
  }

  if (!change.data.enabledAfter || !ctx.config.enabled) return;

  const flipped = !change.data.enabledBefore || change.data.changedKeys.includes('enabled');
  if (!flipped) return;

  const ready = bound(ctx, deps, 'follow-up deadlines were not moved on after the module was off');
  if (ready !== null) {
    await ready.store.extendInfoDeadlines(ctx.guildId, ready.now() + INFO_GRACE_MS);
  }
  await armSweep(ctx, deps.now?.() ?? Date.now());
}

async function onGuildAvailable(_event: ProtonEvent, ctx: Ctx, deps: ApplicationsDeps) {
  if (!ctx.config.enabled) return;
  await armSweep(ctx, deps.now?.() ?? Date.now());
}

async function onWorkRequested(event: ProtonEvent, ctx: Ctx, deps: ApplicationsDeps) {
  const request = applicationWorkRequestedSchema.safeParse(event.payload);
  if (!request.success || request.data.guildId !== ctx.guildId) return;

  const ready = bound(ctx, deps, 'queued applications work did not run');
  if (ready === null) return;

  try {
    await runApplicationWork(ctx, ready, request.data.applicationId);
  } catch (error) {
    ctx.logger.warn(
      `applications could not run queued work straight away, so the sweep will: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, applicationId: request.data.applicationId },
    );
    await armSweep(ctx, ready.now());
  }
}

async function onXpGranted(event: ProtonEvent, ctx: Ctx, deps: ApplicationsDeps) {
  const answer = xpGrantedSchema.safeParse(event.payload);
  if (!answer.success) return;
  if (answer.data.sourceModule !== MODULE_ID || answer.data.guildId !== ctx.guildId) return;

  const applicationId = applicationOfGrant(ctx.guildId, answer.data.grantId);
  if (applicationId === null) return;

  const ready = bound(ctx, deps, 'an XP reward confirmation was not recorded');
  if (ready === null) return;

  const outcome: RequestAnswer =
    answer.data.status === 'granted'
      ? {
          status: 'succeeded',
          result: {
            grantId: answer.data.grantId,
            amount: answer.data.amount,
            ...(answer.data.level === undefined ? {} : { level: answer.data.level }),
          },
        }
      : {
          status: 'failed',
          errorCode: 'xp_refused',
          error:
            answer.data.reason === undefined
              ? XP_REFUSED
              : `Leveling refused the XP reward: ${answer.data.reason}`.slice(0, REASON_MAX),
        };

  const effect = await ready.store.answerRequested(
    ctx.guildId,
    { applicationId, effectKey: XP_KEY },
    outcome,
  );
  await settled(ctx, ready, effect, false);
}

async function onTicketAnswered(event: ProtonEvent, ctx: Ctx, deps: ApplicationsDeps) {
  const answer = ticketOpenAnsweredSchema.safeParse(event.payload);
  if (!answer.success) return;
  if (answer.data.sourceModule !== MODULE_ID || answer.data.guildId !== ctx.guildId) return;

  const ready = bound(ctx, deps, 'an interview ticket answer was not recorded');
  if (ready === null) return;

  const { requestId, sourceRef: applicationId, status, ticketId } = answer.data;
  const outcome: RequestAnswer =
    status === 'refused'
      ? {
          status: 'failed',
          errorCode: 'ticket_refused',
          error: (answer.data.reason ?? TICKET_REFUSED).slice(0, REASON_MAX),
        }
      : {
          status: 'succeeded',
          result: {
            outcome: status,
            ...(ticketId === undefined ? {} : { ticketId }),
            ...(answer.data.number === undefined ? {} : { number: answer.data.number }),
            ...(answer.data.channelId === undefined ? {} : { channelId: answer.data.channelId }),
          },
        };

  const effect = await ready.store.answerRequested(
    ctx.guildId,
    { applicationId, effectId: requestId },
    outcome,
  );
  if (effect === null) return;

  if (effect.status === 'succeeded' && status !== 'refused' && ticketId !== undefined) {
    await ready.store.rememberInterview(
      ctx.guildId,
      applicationId,
      ticketId,
      answer.data.channelId ?? null,
    );
  }
  await settled(ctx, ready, effect, true);
}

export function createApplicationsListeners(
  deps: ApplicationsDeps,
): EventListener<ApplicationsConfig>[] {
  return [
    {
      types: ['proton.panel_requested'],
      handler: (event, ctx) => onPanelRequested(event, ctx),
    },
    {
      types: ['proton.config_changed'],
      handler: (event, ctx) => onConfigChanged(event, ctx, deps),
    },
    {
      types: ['guild.available'],
      handler: (event, ctx) => onGuildAvailable(event, ctx, deps),
    },
    {
      types: ['applications.work_requested'],
      handler: (event, ctx) => onWorkRequested(event, ctx, deps),
    },
    {
      types: ['xp.granted'],
      handler: (event, ctx) => onXpGranted(event, ctx, deps),
    },
    {
      types: ['tickets.open_answered'],
      handler: (event, ctx) => onTicketAnswered(event, ctx, deps),
    },
  ];
}
