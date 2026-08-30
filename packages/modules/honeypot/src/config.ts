import {
  durationStringSchema,
  liftLegacyMessage,
  limitFor,
  messageObjectSchema,
  protonFields,
  refineMessage,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';
import {
  DEFAULT_DM_LAYOUT,
  DEFAULT_NOTICE_LAYOUT,
  HONEYPOT_ACCENT,
  refineHoneypotLayout,
} from './layout.ts';

export const MODULE_ID = 'honeypot';

export const HONEYPOT_ACTOR = 'proton:honeypot';

export const HONEYPOT_ACTIONS = ['softban', 'ban', 'kick', 'timeout', 'warn', 'none'] as const;
export type HoneypotAction = (typeof HONEYPOT_ACTIONS)[number];

export const DELETE_SECONDS_MAX = 604_800;

export const WAIT_SECONDS_MAX = 604_800;

export const SECONDS_PER_DAY = 86_400;

export const AUDIT_REASON_MAX = 512;

export const HONEYPOT_COLOUR = HONEYPOT_ACCENT;

export const DEFAULT_AUDIT_REASON = 'Honeypot: posted in a channel that exists to catch spam bots.';

// The PRO ceiling, not this guild's. The per-guild cap is enforced at save time from configLimits;
// this only stops a hand-edited config from being unbounded.
export const CHANNELS_CEILING = limitFor('pro', 'honeypotChannels');

export const honeypotChannelSchema = z.object({
  channelId: snowflakeSchema,

  // Per channel, so a trap can be taken out of service without losing how it was set up.
  enabled: z.boolean().default(true),
});

export type HoneypotChannel = z.infer<typeof honeypotChannelSchema>;

export const honeypotChannelsSchema = z
  .array(honeypotChannelSchema)
  .max(CHANNELS_CEILING)
  .default([])
  .superRefine((channels, ctx) => {
    const seen = new Set<string>();

    for (const [index, channel] of channels.entries()) {
      if (seen.has(channel.channelId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'channelId'],
          message:
            'This channel is already a honeypot. Edit the row above instead of adding it twice.',
        });
      }
      seen.add(channel.channelId);
    }
  });

export const honeypotLayoutSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine((message, ctx) => {
    refineMessage(message, ctx);
    refineHoneypotLayout(message, ctx);
  }),
);

export type HoneypotLayout = z.infer<typeof honeypotLayoutSchema>;

// Parsed once at import, and the parsed value is what the schema defaults to. A malformed default
// is then a boot failure in every process rather than something one guild's save discovers.
export const DEFAULT_NOTICE_MESSAGE: HoneypotLayout =
  honeypotLayoutSchema.parse(DEFAULT_NOTICE_LAYOUT);
export const DEFAULT_DM_MESSAGE: HoneypotLayout = honeypotLayoutSchema.parse(DEFAULT_DM_LAYOUT);

const ACTION_LABELS: Record<HoneypotAction, string> = {
  softban: 'Softban — remove them and delete what they posted',
  ban: 'Ban',
  kick: 'Kick',
  timeout: 'Timeout',
  warn: 'Warn',
  none: 'Log it and do nothing else',
};

const settings = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Honeypot enabled' }),

  includeThreads: z.boolean().default(true).register(protonFields, {
    label: 'Threads count too',
    description: 'A thread under a bait channel is part of the trap',
  }),

  keepChannelActive: z.boolean().default(false).register(protonFields, {
    label: 'Keep the channel active',
    description: 'Posts something once a day so the channel does not read as abandoned',
  }),

  renameChannelDaily: z.boolean().default(false).register(protonFields, {
    label: 'Rename the channel daily',
    description: 'Rotates the bait channel’s name once a day',
  }),

  action: z.enum(HONEYPOT_ACTIONS).default('softban').register(protonFields, {
    label: 'What happens to them',
    optionLabels: ACTION_LABELS,
  }),

  timeoutFirst: z.boolean().default(false).register(protonFields, {
    label: 'Time them out first',
    description: 'Silences them before the action lands, so a burst stops immediately',
  }),

  timeoutFirstDuration: durationStringSchema.default('5m').register(protonFields, {
    label: 'Held for',
    showWhen: { path: 'timeoutFirst', equals: ['true'] },
  }),

  timeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    label: 'Timed out for',
    showWhen: { path: 'action', equals: ['timeout'] },
  }),

  deleteMessageSeconds: z
    .number()
    .int()
    .min(0)
    .max(DELETE_SECONDS_MAX)
    .default(DELETE_SECONDS_MAX)
    .register(protonFields, {
      label: 'Messages to wipe',
      description: 'How far back their messages are deleted. Only a softban or a ban can do this',
    }),

  waitBeforeActingSeconds: z
    .number()
    .int()
    .min(0)
    .max(WAIT_SECONDS_MAX)
    .default(0)
    .register(protonFields, {
      label: 'Wait before acting',
      description: 'Leave at zero to act immediately',
    }),

  auditLogReason: z
    .string()
    .trim()
    .min(1)
    .max(AUDIT_REASON_MAX)
    .default(DEFAULT_AUDIT_REASON)
    .register(protonFields, {
      label: 'Audit log reason',
      description: 'What Discord’s own audit log records against the action',
    }),

  deleteTriggerMessage: z.boolean().default(true).register(protonFields, {
    label: 'Delete their message',
  }),

  exemptAdministrators: z.boolean().default(true).register(protonFields, {
    label: 'Exempt administrators',
    description: 'Anyone holding Administrator is caught and counted, but not acted on',
  }),

  exemptAdminRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Exempt admin role',
  }),

  exemptRoleIds: z.array(snowflakeSchema).max(50).default([]).register(protonFields, {
    field: 'role-id',
    label: 'Exempt roles',
  }),

  postNotice: z.boolean().default(true).register(protonFields, {
    label: 'Post the warning',
    description: 'Puts a notice in every bait channel so a member who wanders in knows to leave',
  }),

  noticeCounterButton: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Counter button',
      description: 'Shows the live number this trap has caught',
      showWhen: { path: 'postNotice', equals: ['true'] },
    }),

  hideWhatIsAHoneypot: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Hide what is a honeypot',
      description: 'Warns members off without saying the channel is a trap',
      showWhen: { path: 'postNotice', equals: ['true'] },
    }),

  sendDirectMessage: z.boolean().default(true).register(protonFields, {
    label: 'Send a direct message',
    description: 'Sent just before the action lands, while there is still a shared server',
  }),

  offerWayBackIn: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Offer a way back in',
      showWhen: { path: 'sendDirectMessage', equals: ['true'] },
    }),

  inviteUrl: z
    .string()
    .trim()
    .max(512)
    .optional()
    .register(protonFields, {
      label: 'Invite link',
      description: 'Where the way back in points. Proton cannot mint one for you',
      showWhen: { path: 'offerWayBackIn', equals: ['true'] },
    }),

  addToBlacklist: z.boolean().default(false).register(protonFields, {
    label: 'Add them to the blacklist',
    description: 'A blocked account cannot pass verification until a moderator lifts it',
  }),

  quoteMessage: z.boolean().default(false).register(protonFields, {
    label: 'Quote the message',
    description: 'Puts what they posted in the incident log',
  }),

  logChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Log channel',
    description: 'Where Proton reports every trap it springs',

    channelTypes: [0, 5, 11, 12],
  }),
};

export const honeypotConfigSchema = z.object({
  ...settings,

  channels: honeypotChannelsSchema,

  appealPanelId: z.string().min(1).max(32).optional(),

  noticeLayout: honeypotLayoutSchema.default(() => DEFAULT_NOTICE_MESSAGE),
  dmLayout: honeypotLayoutSchema.default(() => DEFAULT_DM_MESSAGE),
});

// The four the generated form cannot render: an array of objects, two authored message layouts,
// and an id that has to be picked from another module's panels rather than typed.
export const HONEYPOT_PANEL_KEYS = [
  'channels',
  'noticeLayout',
  'dmLayout',
  'appealPanelId',
] as const;

export const honeypotFormSchema = z.object(settings);

export type HoneypotConfig = z.infer<typeof honeypotConfigSchema>;

export const honeypotDefaultConfig: HoneypotConfig = honeypotConfigSchema.parse({});

export const HONEYPOT_SCHEMA_VERSION = 2;

const V1_ROW_KEYS = ['action', 'deleteMessageSeconds', 'timeoutDuration'] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * v1 kept the action, the delete window and the timeout length on every channel row; v2 keeps one
 * of each for the whole module. Rows that disagreed cannot all be honoured, so the first armed row
 * decides and the rest are logged nowhere — which is why the dashboard tells a migrated guild to
 * open the page and check it.
 */
export function liftStoredConfig(raw: unknown): unknown {
  const source = record(raw);
  if (!source) return raw;

  const rows = Array.isArray(source.channels) ? source.channels.map(record) : [];

  // Gated on a row still carrying a v1 key, so a config that has already been lifted comes back as
  // the very same object rather than a copy the next equality check would call a change.
  const carriers = rows.filter(
    (row): row is Record<string, unknown> =>
      row !== null && V1_ROW_KEYS.some((key) => Object.hasOwn(row, key)),
  );

  if (carriers.length === 0) return raw;

  const deciding = carriers.find((row) => row.enabled !== false) ?? carriers[0];

  const lifted: Record<string, unknown> = { ...source };
  for (const key of V1_ROW_KEYS) {
    if (Object.hasOwn(lifted, key)) continue;
    if (deciding && Object.hasOwn(deciding, key)) lifted[key] = deciding[key];
  }

  lifted.channels = rows.map((row) => ({
    channelId: row?.channelId,
    enabled: row?.enabled ?? true,
  }));

  return lifted;
}

export function channelFor(
  config: HoneypotConfig,
  channelId: string,
  parentId?: string | null,
): HoneypotChannel | undefined {
  const match = config.channels.find(
    (channel) =>
      channel.channelId === channelId ||
      (config.includeThreads && parentId != null && channel.channelId === parentId),
  );

  return match?.enabled === true ? match : undefined;
}

export function describeWindow(seconds: number): string {
  if (seconds === 0) return 'no messages';
  if (seconds % SECONDS_PER_DAY === 0) {
    const days = seconds / SECONDS_PER_DAY;
    return days === 1 ? 'the last day' : `the last ${days} days`;
  }

  const hours = Math.round(seconds / 3600);
  return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
}
