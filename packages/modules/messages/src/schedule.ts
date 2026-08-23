import { tryParseDuration } from '@proton/core';
import type { MessagesConfig, SavedMessage, TemplateSchedule } from './config.ts';
import { normaliseTemplateName } from './config.ts';

export type NextRun =
  | { status: 'due'; runAt: Date }
  | { status: 'passed' }
  | { status: 'unreadable'; humanReason: string };

function runFrom(schedule: TemplateSchedule, from: Date, strict: boolean): NextRun {
  const start = Date.parse(schedule.at);
  if (Number.isNaN(start)) {
    return {
      status: 'unreadable',
      humanReason:
        `its start time '${schedule.at}' is not a moment I can read. It has to be a complete ` +
        'ISO timestamp with a timezone, such as 2026-01-31T09:00:00Z.',
    };
  }

  const elapsed = from.getTime() - start;
  const ahead = elapsed < 0 || (elapsed === 0 && !strict);

  if (schedule.mode === 'once') {
    return ahead ? { status: 'due', runAt: new Date(start) } : { status: 'passed' };
  }

  const period = tryParseDuration(schedule.every ?? '');
  if (period === null || period <= 0) {
    return {
      status: 'unreadable',
      humanReason:
        `it is set to repeat every '${schedule.every ?? ''}', which is not an interval I can ` +
        'read. Use a number and a unit, such as 24h or 7d.',
    };
  }

  if (ahead) return { status: 'due', runAt: new Date(start) };

  const steps = strict ? Math.floor(elapsed / period) + 1 : Math.ceil(elapsed / period);
  return { status: 'due', runAt: new Date(start + steps * period) };
}

export function nextRun(schedule: TemplateSchedule, now: Date): NextRun {
  return runFrom(schedule, now, false);
}

// Strictly after, where nextRun is at-or-after: a repeat that has just fired on its exact slot
// would otherwise book that same moment again and post in a loop until the row is cancelled.
export function followingRun(schedule: TemplateSchedule, justRan: Date): NextRun {
  return runFrom(schedule, justRan, true);
}

export type CancelReason = 'module-off' | 'switched-off' | 'unreadable';

export interface ScheduleIntent {
  name: string;
  key: string;
  channelId: string;
  mode: TemplateSchedule['mode'];
  runAt: Date;
}

export interface CancelIntent {
  name: string;
  key: string;
  reason: CancelReason;
  humanReason: string;
}

export interface ReconcilePlan {
  schedule: ScheduleIntent[];
  cancel: CancelIntent[];
}

export function scheduledTemplates(config: MessagesConfig): SavedMessage[] {
  return config.templates.filter((template) => template.schedule !== undefined);
}

export function reconcile(config: MessagesConfig, now: Date): ReconcilePlan {
  const schedule: ScheduleIntent[] = [];
  const cancel: CancelIntent[] = [];

  for (const template of scheduledTemplates(config)) {
    const booked = template.schedule;
    if (!booked) continue;

    const name = template.name;

    // The natural key a booked row already carries. Normalised, because that is what /message post
    // looks a template up by, and two names differing only in case are the same template.
    const key = normaliseTemplateName(name);

    if (!config.enabled) {
      cancel.push({
        name,
        key,
        reason: 'module-off',
        humanReason: 'the Messages module is switched off in this server.',
      });
      continue;
    }

    if (!booked.enabled) {
      cancel.push({
        name,
        key,
        reason: 'switched-off',
        humanReason: 'this template’s schedule is switched off.',
      });
      continue;
    }

    const next = nextRun(booked, now);

    if (next.status === 'due') {
      schedule.push({
        name,
        key,
        channelId: booked.channelId,
        mode: booked.mode,
        runAt: next.runAt,
      });
      continue;
    }

    if (next.status === 'unreadable') {
      cancel.push({ name, key, reason: 'unreadable', humanReason: next.humanReason });
    }

    // 'passed' is left in neither list on purpose: a one-off whose moment is behind us may still
    // be sitting due in the schedule after downtime, and cancelling here would delete it unfired.
  }

  return { schedule, cancel };
}
