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

const severity = (label: string, fallback: Severity = 'off') =>
  z.enum(SEVERITIES).default(fallback).register(protonFields, { label });

export const KEYWORD_PRESETS = ['profanity', 'sexualContent', 'slurs'] as const;
export type KeywordPreset = (typeof KEYWORD_PRESETS)[number];

const automodShape = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description:
      'Switching on creates Proton’s Discord AutoMod rules, and switching off deletes them.',
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
      description: 'Skip messages from members with any of these roles.',
    }),

  exemptChannelIds: z.array(snowflakeSchema).max(50).default([]).register(protonFields, {
    field: 'channel-id',
    label: 'Exempt channels',
    description: 'Skip messages in these channels and their threads.',
  }),

  exemptBots: z.boolean().default(true).register(protonFields, {
    label: 'Exempt bots',
  }),

  alertChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Alert channel',
    description: 'Where Proton reports Automod actions.',
    channelTypes: [0, 5, 11, 12],
  }),

  blockedWords: z.array(z.string().min(1).max(60)).max(1000).default([]).register(protonFields, {
    label: 'Blocked words',
    description: 'Discord blocks messages that contain any of these.',
  }),

  allowedWords: z.array(z.string().min(1).max(60)).max(100).default([]).register(protonFields, {
    label: 'Allowed words',
    description: 'Discord never blocks these, even when a blocked word or preset matches.',
  }),

  presets: z
    .array(z.enum(KEYWORD_PRESETS))
    .max(KEYWORD_PRESETS.length)
    .default([])
    .register(protonFields, {
      label: 'Discord word presets',
    }),

  mentionLimit: z.number().int().min(0).max(50).default(0).register(protonFields, {
    label: 'Discord mention limit',
    description: 'Set to 0 for no limit.',
  }),

  nativeSpam: z.boolean().default(false).register(protonFields, {
    label: 'Discord spam filter',
    description: 'Let Discord block messages it considers spam.',
  }),

  floodSeverity: severity('Message flood'),
  floodCount: z.number().int().min(2).max(50).default(6).register(protonFields, {
    label: 'Message limit',
  }),
  floodWindow: durationStringSchema.default('5s').register(protonFields, {
    field: 'duration',
    label: 'Flood window',
  }),

  duplicateSeverity: severity('Duplicate messages'),
  duplicateCount: z.number().int().min(2).max(50).default(3).register(protonFields, {
    label: 'Repeat limit',
  }),
  duplicateWindow: durationStringSchema.default('30s').register(protonFields, {
    field: 'duration',
    label: 'Duplicate window',
  }),

  mentionsSeverity: severity('Mass mentions'),
  mentionsLimit: z.number().int().min(1).max(50).default(8).register(protonFields, {
    label: 'Mention limit',
  }),

  invitesSeverity: severity('Invite links'),

  linksSeverity: severity('Blocked links'),
  linkBlockDomains: z
    .array(z.string().min(1).max(253))
    .max(200)
    .default([])
    .register(protonFields, {
      label: 'Blocked domains',
      description: 'Includes every subdomain.',
    }),
  linkAllowDomains: z
    .array(z.string().min(1).max(253))
    .max(200)
    .default([])
    .register(protonFields, {
      label: 'Allowed domains',
      description: 'Ignore links to these domains, even when a parent domain is blocked.',
    }),

  attachmentsSeverity: severity('Attachments'),
  attachmentExtensions: z
    .array(z.string().min(1).max(16))
    .max(100)
    .default(['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'vbs', 'jar', 'ps1', 'apk', 'lnk'])
    .register(protonFields, {
      label: 'Blocked file types',
      description:
        'Acts on files whose last extension is on this list, and on disguised double extensions such as invoice.exe.pdf.',
    }),

  patternsSeverity: severity('Custom patterns'),
  regexPatterns: z.array(z.string().min(1).max(260)).max(10).default([]).register(protonFields, {
    label: 'Regex patterns',
  }),

  zalgoSeverity: severity('Zalgo text'),
  capsSeverity: severity('Shouting'),
  capsRatio: z.number().int().min(50).max(100).default(70).register(protonFields, {
    label: 'Capital letter limit',
  }),

  emojiSeverity: severity('Emoji spam'),
  emojiLimit: z.number().int().min(1).max(100).default(12).register(protonFields, {
    label: 'Emoji limit',
  }),

  wallsSeverity: severity('Walls of text'),
  wallMaxLines: z.number().int().min(2).max(200).default(15).register(protonFields, {
    label: 'Line limit',
  }),

  deleteFrom: z.enum(DELETE_FROM).default('low').register(protonFields, {
    label: 'Delete messages',
    description: 'Delete the matching message, whatever action is taken against the member.',
  }),

  lowResponse: z.enum(RESPONSES).default('none').register(protonFields, {
    label: 'Low severity action',
  }),
  mediumResponse: z.enum(RESPONSES).default('warn').register(protonFields, {
    label: 'Medium severity action',
  }),
  highResponse: z.enum(RESPONSES).default('timeout').register(protonFields, {
    label: 'High severity action',
  }),

  mediumTimeout: durationStringSchema.default('10m').register(protonFields, {
    field: 'duration',
    label: 'Medium timeout duration',
  }),
  highTimeout: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'High timeout duration',
  }),
};

// The unrefined object, because the dashboard's descriptor generator walks a ZodObject's shape and
// a refined schema no longer is one.
export const automodFormSchema = z.object(automodShape);

export const automodConfigSchema = automodFormSchema.superRefine((config, ctx) => {
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
