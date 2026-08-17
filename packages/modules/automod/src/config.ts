import {
  durationStringSchema,
  protonFields,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';

export const AUTOMOD_SCHEMA_VERSION = 1;

// "Off" is a severity rather than a separate boolean per check. Eleven checks with an enabled
// flag each would be twenty-two fields for the admin to keep consistent.
export const SEVERITIES = ['off', 'low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type ActiveSeverity = Exclude<Severity, 'off'>;

export const AUTOMOD_CHECKS = [
  'flood',
  'duplicate',
  'mentions',
  'invites',
  'links',
  'attachments',
  'patterns',
  'zalgo',
  'caps',
  'emoji',
  'walls',
] as const;
export type AutomodCheck = (typeof AUTOMOD_CHECKS)[number];

export const RESPONSES = ['none', 'warn', 'timeout', 'kick', 'ban'] as const;
export type Response = (typeof RESPONSES)[number];

export const DELETE_FROM = ['low', 'medium', 'high', 'never'] as const;

const severity = (label: string, description: string, fallback: Severity = 'off') =>
  z.enum(SEVERITIES).default(fallback).register(protonFields, { label, description });

const KEYWORD_PRESETS = ['profanity', 'sexualContent', 'slurs'] as const;
export type KeywordPreset = (typeof KEYWORD_PRESETS)[number];

const automodShape = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Screen messages, and keep this server’s Discord AutoMod rules in step.',
  }),

  exemptRoleIds: z
    .array(snowflakeSchema)
    // Discord's own exempt_roles caps at 20, and these are pushed into it verbatim. A longer list
    // here would be silently truncated on the way out.
    .max(20)
    .default([])
    .register(protonFields, {
      field: 'role-id',
      label: 'Exempt roles',
      description: 'Members holding any of these are never acted on. Usually staff.',
    }),

  exemptChannelIds: z.array(snowflakeSchema).max(50).default([]).register(protonFields, {
    field: 'channel-id',
    label: 'Exempt channels',
    description: 'Nothing posted in these channels is screened.',
  }),

  exemptBots: z.boolean().default(true).register(protonFields, {
    label: 'Exempt bots',
    description: 'Leave other applications’ messages alone.',
  }),

  alertChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Alert channel',
    description: 'Where automod reports what it acted on. Leave empty to act silently.',
    channelTypes: [0, 5, 11, 12],
  }),

  blockedWords: z.array(z.string().min(1).max(60)).max(1000).default([]).register(protonFields, {
    label: 'Blocked words',
    description: 'Pushed to Discord’s AutoMod, which blocks them before Proton ever sees them.',
  }),

  allowedWords: z.array(z.string().min(1).max(60)).max(100).default([]).register(protonFields, {
    label: 'Allowed words',
    description: 'Exceptions to the blocked list and the presets.',
  }),

  presets: z
    .array(z.enum(KEYWORD_PRESETS))
    .max(KEYWORD_PRESETS.length)
    .default([])
    .register(protonFields, {
      label: 'Discord word presets',
      description: 'Discord’s own maintained lists: profanity, sexual content, slurs.',
    }),

  mentionLimit: z.number().int().min(0).max(50).default(0).register(protonFields, {
    label: 'Mention limit (Discord)',
    description: 'Discord blocks messages with more than this many mentions. 0 disables it.',
  }),

  nativeSpam: z.boolean().default(false).register(protonFields, {
    label: 'Discord spam filter',
    description: 'Discord’s own spam heuristic, enforced at its edge for free.',
  }),

  floodSeverity: severity('Message flood', 'Too many messages from one member too quickly.'),
  floodCount: z.number().int().min(2).max(50).default(6).register(protonFields, {
    label: 'Flood: messages',
    description: 'How many messages inside the window count as a flood.',
  }),
  floodWindow: durationStringSchema.default('5s').register(protonFields, {
    field: 'duration',
    label: 'Flood: window',
    description: 'The window the count is measured over.',
  }),

  duplicateSeverity: severity('Duplicate messages', 'The same text posted over and over.'),
  duplicateCount: z.number().int().min(2).max(50).default(3).register(protonFields, {
    label: 'Duplicate: repeats',
    description: 'How many identical messages inside the window count as spam.',
  }),
  duplicateWindow: durationStringSchema.default('30s').register(protonFields, {
    field: 'duration',
    label: 'Duplicate: window',
    description: 'The window repeats are measured over.',
  }),

  mentionsSeverity: severity('Mass mentions', 'More mentions in one message than the limit.'),
  mentionsLimit: z.number().int().min(1).max(50).default(8).register(protonFields, {
    label: 'Mentions: limit',
    description: 'Unique mentions in one message before Proton acts.',
  }),

  invitesSeverity: severity('Invite links', 'Links to other Discord servers.'),

  linksSeverity: severity('Blocked links', 'Links to domains on the list below.'),
  linkBlockDomains: z
    .array(z.string().min(1).max(253))
    .max(200)
    .default([])
    .register(protonFields, {
      label: 'Blocked domains',
      description: 'A domain here also covers its subdomains.',
    }),
  linkAllowDomains: z
    .array(z.string().min(1).max(253))
    .max(200)
    .default([])
    .register(protonFields, {
      label: 'Allowed domains',
      description: 'Checked first, so an allowed domain is never blocked.',
    }),

  attachmentsSeverity: severity('Attachments', 'Files with a blocked extension.'),
  attachmentExtensions: z
    .array(z.string().min(1).max(16))
    .max(100)
    .default(['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'vbs', 'jar', 'ps1', 'apk', 'lnk'])
    .register(protonFields, {
      label: 'Blocked file types',
      description: 'Matched on the filename’s last extension, which is what Discord serves.',
    }),

  patternsSeverity: severity('Custom patterns', 'Messages matching a pattern below.'),
  regexPatterns: z
    .array(z.string().min(1).max(260))
    .max(10)
    .default([])
    .register(protonFields, {
      label: 'Patterns',
      description:
        'Regular expressions. Ones Discord’s engine also accepts are pushed to it; the rest ' +
        'Proton runs itself.',
    }),

  zalgoSeverity: severity('Zalgo text', 'Stacked combining marks used to break layout.'),
  capsSeverity: severity('Shouting', 'Messages that are mostly capital letters.'),
  capsRatio: z.number().int().min(50).max(100).default(70).register(protonFields, {
    label: 'Caps: percent',
    description: 'How much of a message must be capitals before it counts as shouting.',
  }),

  emojiSeverity: severity('Emoji spam', 'More emoji in one message than the limit.'),
  emojiLimit: z.number().int().min(1).max(100).default(12).register(protonFields, {
    label: 'Emoji: limit',
    description: 'Emoji in one message before Proton acts.',
  }),

  wallsSeverity: severity('Walls of text', 'Very long messages, or many blank lines.'),
  wallMaxLines: z.number().int().min(2).max(200).default(15).register(protonFields, {
    label: 'Walls: lines',
    description: 'Lines in one message before it counts as a wall.',
  }),

  deleteFrom: z.enum(DELETE_FROM).default('low').register(protonFields, {
    label: 'Delete from severity',
    description: 'The lowest severity whose messages are deleted. "never" keeps every message.',
  }),

  lowResponse: z.enum(RESPONSES).default('none').register(protonFields, {
    label: 'Low severity response',
    description: 'What happens to the member, beyond deleting the message.',
  }),
  mediumResponse: z.enum(RESPONSES).default('warn').register(protonFields, {
    label: 'Medium severity response',
    description: 'What happens to the member, beyond deleting the message.',
  }),
  highResponse: z.enum(RESPONSES).default('timeout').register(protonFields, {
    label: 'High severity response',
    description: 'What happens to the member, beyond deleting the message.',
  }),

  mediumTimeout: durationStringSchema.default('10m').register(protonFields, {
    field: 'duration',
    label: 'Medium timeout',
    description: 'How long a medium-severity timeout lasts.',
  }),
  highTimeout: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'High timeout',
    description: 'How long a high-severity timeout lasts.',
  }),
};

export const automodConfigSchema = z.object(automodShape).superRefine((config, ctx) => {
  for (const pattern of config.regexPatterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['regexPatterns'],
        message: `'${pattern}' is not a valid regular expression: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    // Caught on save rather than in the message path: a pattern that backtracks catastrophically
    // wedges the consumer for every message in the guild, and the admin would have no way to tell
    // which of their patterns did it.
    if (NESTED_QUANTIFIER.test(pattern)) {
      ctx.addIssue({
        code: 'custom',
        path: ['regexPatterns'],
        message:
          `'${pattern}' nests one unbounded repeat inside another, which can take exponential ` +
          'time on a message crafted to exploit it. Rewrite it without the nested + or *.',
      });
    }
  }
});

const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;

export type AutomodConfig = z.infer<typeof automodConfigSchema>;

export const automodDefaultConfig: AutomodConfig = automodConfigSchema.parse({});

export interface AutomodSettings {
  floodWindowMs: number;
  duplicateWindowMs: number;
  mediumTimeoutMs: number;
  highTimeoutMs: number;
}

export type SettingsResult = { settings: AutomodSettings } | { invalid: string };

export function readSettings(config: AutomodConfig): SettingsResult {
  const durations = {
    floodWindow: tryParseDuration(config.floodWindow),
    duplicateWindow: tryParseDuration(config.duplicateWindow),
    mediumTimeout: tryParseDuration(config.mediumTimeout),
    highTimeout: tryParseDuration(config.highTimeout),
  };

  for (const [field, value] of Object.entries(durations)) {
    if (value === null) {
      return {
        invalid:
          `Automod is enabled but its stored configuration is unreadable: ${field}=` +
          `'${config[field as keyof AutomodConfig] as string}'. It must be a number followed by ` +
          's, m, h, d or w — fix it on the Automod page of the Proton dashboard.',
      };
    }
  }

  return {
    settings: {
      floodWindowMs: durations.floodWindow as number,
      duplicateWindowMs: durations.duplicateWindow as number,
      mediumTimeoutMs: durations.mediumTimeout as number,
      highTimeoutMs: durations.highTimeout as number,
    },
  };
}

export function severityOf(config: AutomodConfig, check: AutomodCheck): Severity {
  return config[`${check}Severity` as keyof AutomodConfig] as Severity;
}

const RANK: Record<ActiveSeverity, number> = { low: 1, medium: 2, high: 3 };

export function outranks(a: ActiveSeverity, b: ActiveSeverity): boolean {
  return RANK[a] > RANK[b];
}

export function responseFor(config: AutomodConfig, severity: ActiveSeverity): Response {
  if (severity === 'high') return config.highResponse;
  if (severity === 'medium') return config.mediumResponse;
  return config.lowResponse;
}

export function deletesAt(config: AutomodConfig, severity: ActiveSeverity): boolean {
  if (config.deleteFrom === 'never') return false;
  return RANK[severity] >= RANK[config.deleteFrom as ActiveSeverity];
}
