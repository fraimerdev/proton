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
});

export type ProtonActionExecuted = z.infer<typeof protonActionExecutedSchema>;

export const protonSecurityTrippedSchema = z.object({
  guildId: snowflakeSchema,
  moduleId: z.enum(['antinuke', 'antiraid']),
  trigger: z.string().min(1).max(100),
  actorId: z.string().nullable().default(null),
  summary: z.string().max(1024),
  actionsTaken: z.array(z.string().max(200)).max(20).default([]),
  ownerExempt: z.boolean().default(false),
});

export type ProtonSecurityTripped = z.infer<typeof protonSecurityTrippedSchema>;

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
