import type { EventListener, EventType } from '@proton/core';
import { type MessagesConfig, MODULE_ID } from './config.ts';
import type { MessagesContext } from './perform.ts';
import { reconcile } from './schedule.ts';
import { POST_JOB } from './scheduled-post.ts';

export const MESSAGES_RECONCILE_EVENT_TYPES: EventType[] = [
  'proton.config_changed',
  'guild.available',
];

const NO_SCHEDULER =
  'A template in this server is scheduled but this process has no scheduler: the module context ' +
  'was built without `schedule` and `cancel`, so nothing would ever post. The worker must be ' +
  'started with a scheduled-action store.';

export interface ReconcileOutcome {
  scheduled: number;
  cancelled: number;

  failures: string[];
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function reconcileSchedules(
  ctx: MessagesContext,
  config: MessagesConfig,
  now: Date,
): Promise<ReconcileOutcome> {
  const plan = reconcile(config, now);
  const outcome: ReconcileOutcome = { scheduled: 0, cancelled: 0, failures: [] };

  if (plan.schedule.length === 0 && plan.cancel.length === 0) return outcome;

  if (typeof ctx.schedule !== 'function' || typeof ctx.cancel !== 'function') {
    ctx.logger.error(NO_SCHEDULER, { guildId: ctx.guildId, moduleId: MODULE_ID });
    outcome.failures.push(NO_SCHEDULER);
    return outcome;
  }

  for (const intent of plan.schedule) {
    try {
      // replace, not keep: an admin who moved the time expects the row to move with it.
      await ctx.schedule(
        POST_JOB,
        intent.runAt,
        intent.key,
        { templateName: intent.name, runAt: intent.runAt.toISOString() },
        { replace: true },
      );
      outcome.scheduled += 1;
    } catch (error) {
      const failure = `“${intent.name}” could not be scheduled: ${reasonFor(error)}`;
      outcome.failures.push(failure);
      ctx.logger.error(
        `${failure}. It will not post until this server’s Messages settings are saved again.`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, template: intent.name },
      );
    }
  }

  for (const intent of plan.cancel) {
    try {
      await ctx.cancel(POST_JOB, intent.key);
      outcome.cancelled += 1;
    } catch (error) {
      const failure = `“${intent.name}” could not be taken off the schedule: ${reasonFor(error)}`;
      outcome.failures.push(failure);
      ctx.logger.error(
        `${failure}. It was meant to stop because ${intent.humanReason} It may still post once ` +
          'more; the post itself re-reads this server’s settings and will do nothing.',
        { guildId: ctx.guildId, moduleId: MODULE_ID, template: intent.name },
      );
    }
  }

  return outcome;
}

export function createMessagesScheduleListener(): EventListener<MessagesConfig> {
  return {
    types: MESSAGES_RECONCILE_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.guildId === null) return;

      const ourChange = event.type === 'proton.config_changed';
      if (ourChange && field(event.payload, 'moduleId') !== MODULE_ID) return;

      // The module-level switch is not part of the config schema, so a module that has just been
      // switched off can only learn it from the event that announced the change — and it has to,
      // or every schedule it owns keeps firing with nothing left running to stop it.
      const active = ourChange ? field(event.payload, 'enabledAfter') !== false : true;
      const config = active ? ctx.config : { ...ctx.config, enabled: false };

      const outcome = await reconcileSchedules(ctx, config, new Date());
      if (outcome.scheduled + outcome.cancelled === 0) return;

      ctx.logger.info(
        `message schedules reconciled: ${outcome.scheduled} scheduled, ${outcome.cancelled} cancelled`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    },
  };
}
