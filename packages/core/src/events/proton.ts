import { z } from 'zod';
import { ACTION_KINDS } from '../actions/kinds.ts';
import { snowflakeSchema } from '../actions/payloads.ts';

// Changed keys only, never values. A config blob can hold a webhook URL or a token somebody
// pasted into a free-text field, and a log channel is a wider audience than the dashboard.
export const protonConfigChangedSchema = z.object({
  auditId: z.string().min(1),
  guildId: snowflakeSchema,
  moduleId: z.string().min(1),
  moduleName: z.string().min(1).optional(),
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']),
  enabledBefore: z.boolean(),
  enabledAfter: z.boolean(),
  changedKeys: z.array(z.string().max(100)).max(64).default([]),
});

export type ProtonConfigChanged = z.infer<typeof protonConfigChangedSchema>;

export const COMMAND_CHANGES = [
  'name',
  'description',
  'options',
  'privateReply',
  'enabled',
] as const;

export type CommandChange = (typeof COMMAND_CHANGES)[number];

export const protonCommandsChangedSchema = z.object({
  auditId: z.string().min(1),
  guildId: snowflakeSchema,
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']),
  key: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  newName: z.string().min(1).max(100).nullable().default(null),
  changed: z.array(z.enum(COMMAND_CHANGES)).max(COMMAND_CHANGES.length).default([]),
  enabledBefore: z.boolean(),
  enabledAfter: z.boolean(),
  registration: z.boolean(),
});

export type ProtonCommandsChanged = z.infer<typeof protonCommandsChangedSchema>;

export const MODERATION_ACTION_KINDS = [
  'warn',
  'unwarn',
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'purge',
  'slowmode',
  'lockdown',
  'unlock',
] as const satisfies readonly (typeof ACTION_KINDS)[number][];

export type ModerationActionKind = (typeof MODERATION_ACTION_KINDS)[number];

const MODERATION_KIND_SET: ReadonlySet<string> = new Set(MODERATION_ACTION_KINDS);

export function isModerationActionKind(kind: string): kind is ModerationActionKind {
  return MODERATION_KIND_SET.has(kind);
}

export const protonActionExecutedSchema = z.object({
  caseId: z.string().min(1),
  guildId: snowflakeSchema,
  moduleId: z.string().min(1),
  kind: z.enum(ACTION_KINDS),
  actorId: z.string().min(1),
  targetId: z.string().nullable().default(null),
  reason: z.string().max(512).nullable().default(null),
  dryRun: z.boolean().default(false),
  expiresAt: z.number().int().nullable().default(null),
  until: z.number().int().nullable().optional(),
  channelId: snowflakeSchema.nullable().optional(),
  seconds: z.number().int().nonnegative().optional(),
  reversal: z.boolean().optional(),
});

export type ProtonActionExecuted = z.infer<typeof protonActionExecutedSchema>;

export const protonSecurityTrippedSchema = z.object({
  guildId: snowflakeSchema,
  moduleId: z.enum(['antinuke', 'antiraid', 'honeypot']),
  trigger: z.string().min(1).max(100),
  actorId: z.string().nullable().default(null),
  summary: z.string().max(1024),
  actionsTaken: z.array(z.string().max(200)).max(20).default([]),
  ownerExempt: z.boolean().default(false),
});

export type ProtonSecurityTripped = z.infer<typeof protonSecurityTrippedSchema>;

/**
 * An admin pressing "post it" in the dashboard. The api cannot talk to Discord — the worker is the
 * only process allowed to — so the button publishes this and the owning module's listener does the
 * posting, exactly as `verification.web_passed` already works.
 *
 * The panel is named, never carried: the worker re-reads the config it is about to post, so a panel
 * edited between the press and the send is posted as it is now rather than as it was on the page.
 */
export const protonPanelRequestedSchema = z.object({
  auditId: z.string().min(1),
  guildId: snowflakeSchema,
  moduleId: z.string().min(1),
  panelId: z.string().min(1).max(100),
  actorId: z.string().min(1),
});

export type ProtonPanelRequested = z.infer<typeof protonPanelRequestedSchema>;

export function diffKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];

  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }

  return changed.sort();
}
