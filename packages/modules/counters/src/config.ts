import { limitFor, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'counters';

export const CHANNEL_NAME_MAX = 100;

export const TEMPLATE_MAX = 90;

export const COUNT_PLACEHOLDER = '{count}';

export const COUNTERS_CEILING = limitFor('pro', 'counters');

// A rename sits in its own far tighter bucket than any other channel edit — two per ten minutes
// per channel — so this is a floor, not a default, and there is deliberately no setting for it.
export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export const COUNTER_SOURCES = ['members', 'roles', 'channels'] as const;

export type CounterSource = (typeof COUNTER_SOURCES)[number];

export const COUNTER_ID_MAX = 32;

const counterIdSchema = z
  .string()
  .min(1)
  .max(COUNTER_ID_MAX)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'must start with a letter or digit and contain only letters, digits, hyphens and underscores',
  );

function liftLegacyCounter(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;

  const counter = raw as Record<string, unknown>;
  if (typeof counter.id === 'string') return counter;

  // A counter saved before Proton could make its own channel is identified by the channel it was
  // pointed at. Minting a fresh id here instead would hand it a different one on every read, and
  // the id is what a Proton-made channel is filed under.
  return typeof counter.channelId === 'string' ? { ...counter, id: counter.channelId } : counter;
}

export const counterSchema = z.preprocess(
  liftLegacyCounter,
  z.object({
    id: counterIdSchema,

    // Absent means Proton makes the channel and owns it from then on. Present means the counter
    // renames a channel somebody else made, which is the only shape that existed before.
    // Cloned first: register() mutates the instance it is given, so registering on the shared
    // snowflakeSchema puts this label on every channel and role field in every other module.
    channelId: snowflakeSchema
      .clone()
      .register(protonFields, {
        field: 'channel-id',
        label: 'Channel',
        description: 'Discord rewrites text channel names to lowercase-with-dashes',
      })
      .optional(),

    template: z
      .string()
      .min(1)
      .max(TEMPLATE_MAX)
      .refine((value) => value.includes(COUNT_PLACEHOLDER), {
        message:
          `a counter template needs ${COUNT_PLACEHOLDER} in it — that is where the number goes, ` +
          'as in “Members: {count}”. Without it the channel would be renamed to a fixed string ' +
          'that never changes.',
      })
      .register(protonFields, {
        label: 'Name template',
      }),

    source: z.enum(COUNTER_SOURCES).register(protonFields, {
      label: 'What to count',
    }),
  }),
);

export type Counter = z.infer<typeof counterSchema>;

export const countersListSchema = z
  .array(counterSchema)
  .max(COUNTERS_CEILING)
  .superRefine((counters, ctx) => {
    const channels = new Set<string>();
    const ids = new Set<string>();

    for (const [index, counter] of counters.entries()) {
      if (counter.channelId !== undefined && channels.has(counter.channelId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'channelId'],
          message:
            'two counters cannot share a channel — they would rename it in turn and each one ' +
            'would spend the other’s rename allowance.',
        });
      }
      if (counter.channelId !== undefined) channels.add(counter.channelId);

      if (ids.has(counter.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message:
            'two counters cannot share an id — the channel Proton makes for a counter is filed ' +
            'under it, so both would rename the same channel.',
        });
      }
      ids.add(counter.id);
    }
  });

const settings = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Counts refresh every 10 minutes, not instantly',
  }),
};

export const countersConfigSchema = z.object({
  ...settings,

  counters: countersListSchema.default([]).register(protonFields, {
    label: 'Counter channels',
  }),
});

// The form generator refuses arrays of objects by design (PLAN.md §9), so the counter list is
// edited by a bespoke dashboard panel and omitted here rather than crashing the settings page.
export const countersFormSchema = z.object(settings);

export type CountersConfig = z.infer<typeof countersConfigSchema>;

export const countersDefaultConfig: CountersConfig = {
  enabled: false,
  counters: [],
};

export const COUNTERS_SCHEMA_VERSION = 1;
