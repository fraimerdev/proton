import { causationSchema, snowflakeSchema, XP_SOURCES } from '@proton/core';
import { z } from 'zod';
import { LEDGER_METRICS, type LedgerMetric } from './triggers.ts';

export const SPAN_METRICS: ReadonlySet<LedgerMetric> = new Set(['voice_minutes', 'voice_stay']);

export const activityRecordSchema = z
  .object({
    guildId: snowflakeSchema,
    userId: snowflakeSchema,
    metric: z.enum(LEDGER_METRICS),
    sourceKey: z.string().min(1).max(200),
    occurredAt: z.number().int(),
    spanStart: z.number().int().nullable(),
    amount: z.number().int().min(1),
    channelId: snowflakeSchema.nullable(),
    parentId: snowflakeSchema.nullable(),
    categoryId: snowflakeSchema.nullable(),
    temporary: z.boolean(),
    xpSource: z.enum(XP_SOURCES).nullable(),
    groupKey: z.string().min(1).max(200).nullable(),
    pending: z.boolean(),
    sourceModule: z.string().min(1).max(40),
    causation: causationSchema,
  })
  .superRefine((record, ctx) => {
    if (SPAN_METRICS.has(record.metric) && record.spanStart === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['spanStart'],
        message: `a ${record.metric} record measures a span, so it needs spanStart`,
      });
    }

    if (record.spanStart !== null && record.spanStart > record.occurredAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['spanStart'],
        message: 'must not be after occurredAt',
      });
    }

    if (record.metric === 'activity_xp' && record.xpSource === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['xpSource'],
        message: 'an activity_xp record needs the XP source it came from',
      });
    }
  });

export type ActivityRecord = z.infer<typeof activityRecordSchema>;
