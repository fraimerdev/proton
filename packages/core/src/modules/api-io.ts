import { z } from 'zod';
import { jsonValueSchema } from '../config/json.ts';
import { ENTITLEMENT_TIERS } from '../rules/facts.ts';

export const moduleSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  fields: z.array(z.string()),
});

export const moduleStatusSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  disabledReason: z.object({ code: z.string(), humanReason: z.string() }).optional(),
});

// Path and label only. The index carries one of these per configurable field of every installed
// module purely so the command palette can find a setting by name; the full descriptor a form
// needs is 41 kB across 27 modules and rides its own endpoint instead.
export const moduleFieldSchema = z.object({ path: z.string(), label: z.string() });

export const moduleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  fields: z.array(moduleFieldSchema),
  commands: z.array(z.string()),

  // The guild's own switch. `status.enabled` is a different question — whether the module *could*
  // run here at all — and the overview shows the two together.
  enabled: z.boolean(),
  dashboard: z.object({ icon: z.string(), sections: z.array(moduleSectionSchema) }).nullable(),
  status: moduleStatusSchema.nullable(),
});

export const moduleIndexSchema = z.object({ modules: z.array(moduleSummarySchema) });

export const moduleConfigViewSchema = z.object({
  moduleId: z.string(),
  enabled: z.boolean(),
  config: z.record(z.string(), jsonValueSchema),
  schemaVersion: z.number().int(),
  migrated: z.boolean(),
  tier: z.enum(ENTITLEMENT_TIERS),
});

export const moduleUpdateResultSchema = z.object({
  before: moduleConfigViewSchema,
  after: moduleConfigViewSchema,
});

export const guildOverviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  locale: z.string(),
  tier: z.enum(ENTITLEMENT_TIERS),
  joinedAt: z.string(),
});

// known:false means Discord could not be asked, not that Proton is in none of them. Callers must
// render that as a third state; treating it as "absent everywhere" is a lie the picker would tell
// on every card at once.
export const guildPresenceSchema = z.object({
  present: z.array(z.string()),
  known: z.boolean(),
});

export const verificationRequestResultSchema = z.object({
  requestId: z.string().min(1),
});

// A decimal string, not a number: the permission set is a 64-bit mask and JSON numbers lose the
// high bits. Discord's own guild object sends it the same way for the same reason.
export const botInviteSchema = z.object({
  permissions: z.string().regex(/^\d+$/),
});

export type ModuleField = z.infer<typeof moduleFieldSchema>;
export type ModuleSection = z.infer<typeof moduleSectionSchema>;
export type ModuleStatusView = z.infer<typeof moduleStatusSchema>;
export type ModuleSummary = z.infer<typeof moduleSummarySchema>;
export type ModuleIndex = z.infer<typeof moduleIndexSchema>;
export type ModuleConfigView = z.infer<typeof moduleConfigViewSchema>;
export type ModuleUpdateResult = z.infer<typeof moduleUpdateResultSchema>;
export type GuildOverview = z.infer<typeof guildOverviewSchema>;
export type GuildPresence = z.infer<typeof guildPresenceSchema>;
export type VerificationRequestResult = z.infer<typeof verificationRequestResultSchema>;
export type BotInvite = z.infer<typeof botInviteSchema>;
