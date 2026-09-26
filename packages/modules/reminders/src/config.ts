import {
  durationStringSchema,
  formatDuration,
  parseDuration,
  protonFields,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'reminders';

export const REMINDER_CONTENT_MAX = 1500;

export const REMINDER_LIST_LIMIT = 25;

export const remindersConfigSchema = z
  .object({
    enabled: z.boolean().default(false).register(protonFields, {
      label: 'Enabled',
    }),

    maxDuration: durationStringSchema.default('365d').register(protonFields, {
      field: 'duration',
      label: 'Furthest ahead',
    }),

    minDuration: durationStringSchema.default('30s').register(protonFields, {
      field: 'duration',
      label: 'Soonest',
    }),
  })

  .superRefine((config, ctx) => {
    const min = tryParseDuration(config.minDuration);
    const max = tryParseDuration(config.maxDuration);
    if (min === null || max === null || min <= max) return;

    ctx.addIssue({
      code: 'custom',
      path: ['minDuration'],
      message:
        `can’t be later than the furthest ahead a reminder can be set (${config.maxDuration}), ` +
        'or every reminder in this server would be refused',
    });
  });

export type RemindersConfig = z.infer<typeof remindersConfigSchema>;

export const remindersDefaultConfig: RemindersConfig = {
  enabled: false,
  maxDuration: '365d',
  minDuration: '30s',
};

export const REMINDERS_SCHEMA_VERSION = 1;

export type DelayResult = { ok: true; ms: number } | { ok: false; humanReason: string };

export function resolveDelay(raw: string, config: RemindersConfig): DelayResult {
  let ms: number;
  try {
    ms = parseDuration(raw);
  } catch (error) {
    return {
      ok: false,
      humanReason:
        error instanceof Error
          ? error.message
          : `“${raw}” isn’t a length of time I understand. Use a number followed by s, m, h, d ` +
            'or w, like 30m, 12h or 7d.',
    };
  }

  const min = tryParseDuration(config.minDuration);
  const max = tryParseDuration(config.maxDuration);

  if (min === null || max === null) {
    return {
      ok: false,
      humanReason:
        `I can’t read this server’s reminder limits (soonest “${config.minDuration}”, ` +
        `furthest ahead “${config.maxDuration}”), so I can’t set reminders right now. Nothing ` +
        'was saved.',
    };
  }

  if (ms < min) {
    return {
      ok: false,
      humanReason:
        `That’s too soon. The soonest you can set a reminder is ${formatDuration(min)} ` +
        'from now.',
    };
  }

  if (ms > max) {
    return {
      ok: false,
      humanReason:
        `That’s too far ahead. The furthest you can set a reminder is ${formatDuration(max)} ` +
        'from now.',
    };
  }

  return { ok: true, ms };
}
