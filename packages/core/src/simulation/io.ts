import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';
import type { ProtonMessage } from '../messages/message.ts';
import { surfaceDiagnosticSchema } from '../placeholders/surface.ts';
import { ENTITLEMENT_TIERS } from '../rules/facts.ts';
import { simulationAttachmentSchema, simulationDescriptorSchema } from './types.ts';

export const SIMULATION_MODES = ['preview', 'send'] as const;

export type SimulationMode = (typeof SIMULATION_MODES)[number];

export const pathDiagnosticSchema = surfaceDiagnosticSchema.extend({ path: z.string() });

/**
 * The placeholder states that mean "this came out empty and an admin should know". `not_set` is
 * included even though it is only an info: a message reading "Welcome, !" is exactly what this
 * feature exists to show before the real event does.
 */
export const UNRESOLVED_CODES = [
  'not_set',
  'unavailable',
  'restricted',
  'resolver_failed',
  'unknown_placeholder',
  'mention_without_name',
] as const;

const UNRESOLVED: ReadonlySet<string> = new Set(UNRESOLVED_CODES);

export function unresolvedDiagnostics<D extends { code: string }>(
  diagnostics: readonly D[],
): readonly D[] {
  return diagnostics.filter((diagnostic) => UNRESOLVED.has(diagnostic.code));
}

export const simulationInputValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const simulationRunSchema = z.object({
  simulationId: z.string().min(1).max(64),
  mode: z.enum(SIMULATION_MODES),

  // Client-generated and echoed back: two presses of the same button carry one id, and the worker
  // hands the second the first one's answer instead of posting twice.
  requestId: z.string().min(8).max(64),

  subjectId: snowflakeSchema.optional(),
  channelId: snowflakeSchema.optional(),
  inputs: z.record(z.string().max(32), simulationInputValueSchema).default({}),

  // Absent means "use what is saved". Present means the admin is testing what is on screen, which
  // is validated here exactly as a save would be and never written.
  draft: z.record(z.string(), z.unknown()).optional(),
});

export type SimulationRun = z.infer<typeof simulationRunSchema>;

export const simulationDestinationSchema = z.object({
  kind: z.enum(['channel', 'dm', 'none']),
  channelId: z.string().nullable(),
  label: z.string(),
});

export type SimulationDestination = z.infer<typeof simulationDestinationSchema>;

export const simulationRenderSchema = z.object({
  kind: z.enum(['message', 'text']),

  // Not messageObjectSchema: a module that mints its own custom ids — Honeypot's counter button,
  // Verification's verify button — renders a button carrying no stored action, which the authoring
  // schema refuses on purpose. What arrives here was already parsed as config by the module's own
  // schema and re-checked by renderMessageTemplate, so re-applying the authoring rules would refuse
  // valid renders and nothing else.
  message: z
    .custom<ProtonMessage>((value) => typeof value === 'object' && value !== null)
    .nullable(),
  text: z.string().nullable(),
  attachments: z.array(simulationAttachmentSchema).max(4),
  caption: z.string(),
  diagnostics: z.array(pathDiagnosticSchema),
  mentionNames: z.record(z.string(), z.string()),
  now: z.number().int(),
});

export type SimulationRender = z.infer<typeof simulationRenderSchema>;

export const simulationSentSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  url: z.string().nullable(),
  markerOmitted: z.string().nullable(),
});

export type SimulationSent = z.infer<typeof simulationSentSchema>;

export const simulationOutcomeSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(SIMULATION_MODES),
  simulationId: z.string(),
  usedDraft: z.boolean(),
  destination: simulationDestinationSchema,
  render: simulationRenderSchema.nullable(),
  sent: simulationSentSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export type SimulationOutcome = z.infer<typeof simulationOutcomeSchema>;

export const simulationRequestedPayloadSchema = z.object({
  requestId: z.string().min(8).max(64),
  guildId: snowflakeSchema,
  moduleId: z.string().min(1),
  simulationId: z.string().min(1),
  mode: z.enum(SIMULATION_MODES),
  actorId: snowflakeSchema,
  subjectId: snowflakeSchema,
  channelId: snowflakeSchema.nullable(),
  inputs: z.record(z.string().max(32), simulationInputValueSchema),
  config: z.record(z.string(), z.unknown()),
  tier: z.enum(ENTITLEMENT_TIERS),
  usedDraft: z.boolean(),
});

export type SimulationRequestedPayload = z.infer<typeof simulationRequestedPayloadSchema>;

export const simulationCatalogueSchema = z.object({
  moduleId: z.string(),
  simulations: z.array(simulationDescriptorSchema),
});

export type SimulationCatalogue = z.infer<typeof simulationCatalogueSchema>;

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
