import { z } from 'zod';
import type { GuildState } from '../guild-state/types.ts';
import type { ProtonMessage } from '../messages/message.ts';
import type { PathDiagnostic } from '../placeholders/message-fields.ts';
import type {
  BotFacts,
  ChannelFacts,
  MemberFacts,
  ServerFacts,
  UserFacts,
} from '../placeholders/shared/facts.ts';
import type { EntitlementTier } from '../rules/facts.ts';

export const SIMULATION_INPUT_KINDS = ['integer', 'text', 'choice', 'boolean'] as const;

export type SimulationInputKind = (typeof SIMULATION_INPUT_KINDS)[number];

export const simulationChoiceSchema = z.object({
  value: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
});

export type SimulationChoice = z.infer<typeof simulationChoiceSchema>;

const inputBase = {
  key: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  label: z.string().min(1).max(60),
  help: z.string().max(160).optional(),

  // Supplied by the page rather than picked in the dialog — which panel, which saved template,
  // which hub. Drawing a control for one would ask an admin to pick the thing they opened.
  fixed: z.boolean().optional(),
};

export const simulationInputSchema = z.discriminatedUnion('kind', [
  z.object({
    ...inputBase,
    kind: z.literal('integer'),
    min: z.number().int(),
    max: z.number().int(),
    fallback: z.number().int(),
  }),
  z.object({
    ...inputBase,
    kind: z.literal('text'),
    maxLength: z.number().int().min(1).max(2000),
    fallback: z.string(),
  }),
  z.object({
    ...inputBase,
    kind: z.literal('choice'),
    options: z.array(simulationChoiceSchema).min(1).max(25),
    fallback: z.string().min(1),
  }),
  z.object({ ...inputBase, kind: z.literal('boolean'), fallback: z.boolean() }),
]);

export type SimulationInput = z.infer<typeof simulationInputSchema>;

export const SIMULATION_DELIVERIES = ['channel', 'dm', 'none'] as const;

export type SimulationDelivery = (typeof SIMULATION_DELIVERIES)[number];

export const SIMULATION_OUTPUTS = ['message', 'text'] as const;

export type SimulationOutputKind = (typeof SIMULATION_OUTPUTS)[number];

export const simulationCardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['rank', 'welcome', 'goodbye']),
    preset: z.string().min(1).max(32).optional(),
    accent: z.number().int().min(0).max(0xffffff).optional(),
    background: z.string().max(2048).optional(),
    displayName: z.string().min(1).max(64),
    guildName: z.string().min(1).max(100).optional(),
    avatar: z.string().max(2048).optional(),
    showRank: z.boolean().optional(),
    showPercent: z.boolean().optional(),
    showTotalXp: z.boolean().optional(),
    showMemberCount: z.boolean().optional(),

    memberCount: z.number().int().min(0).optional(),
    level: z.number().int().min(0).optional(),
    rank: z.number().int().min(0).optional(),
    totalXp: z.number().int().min(0).optional(),
    xpIntoLevel: z.number().int().min(0).optional(),
    xpForNextLevel: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('badge'),
    shape: z.string().min(1).max(16),
    colour: z.number().int().min(0).max(0xffffff),
    icon: z.string().min(1).max(32).optional(),
    assetId: z
      .string()
      .regex(/^[a-z0-9]{8,40}$/)
      .optional(),
  }),
]);

export type SimulationCard = z.infer<typeof simulationCardSchema>;

/**
 * The card preview route's query, built in one place so the dashboard's preview and the worker's
 * delivery ask the api for the same bytes. Without it the two would drift into a preview of a
 * card nobody is ever sent.
 */
export function simulationCardQuery(card: SimulationCard): string {
  const params = new URLSearchParams({ kind: card.kind });

  for (const [key, value] of Object.entries(card)) {
    if (key === 'kind' || value === undefined) continue;
    params.set(key, String(value));
  }

  return params.toString();
}

export const simulationAttachmentSchema = z.object({
  filename: z.string().min(1).max(64),
  card: simulationCardSchema,
});

export type SimulationAttachment = z.infer<typeof simulationAttachmentSchema>;

export const simulationDescriptorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
  moduleId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(60),
  summary: z.string().min(1).max(200),
  // Absent only where the module authors a message that holds no placeholders at all, so there is
  // no surface to render it through. Present everywhere else, and checked against the module's own
  // templates at boot.
  surfaceId: z.string().min(1).optional(),
  configPath: z.string().min(1),
  output: z.enum(SIMULATION_OUTPUTS),
  delivery: z.enum(SIMULATION_DELIVERIES),

  // Where the module's own config keeps the channel this normally posts in. The dialog defaults
  // the destination to it and offers to send somewhere else.
  channelPath: z.string().min(1).optional(),

  // False for a simulation whose subject is the server rather than a member — a counter name has
  // nobody to stand in for, and offering a member picker there would be a lie.
  subject: z.boolean(),
  inputs: z.array(simulationInputSchema).max(6),
  // Shown in the dialog above the inputs: what this variant is and anything an admin has to know
  // before pressing send. Optional because most variants need no warning.
  note: z.string().max(240).optional(),
});

export type SimulationDescriptor = z.infer<typeof simulationDescriptorSchema>;

export interface SimulationPerson {
  user: UserFacts;
  member: MemberFacts | 'unavailable';
  displayName: string;
}

/**
 * Everything a simulation may know, resolved once from the real guild before any adapter runs.
 * `guildState` is the whole cached snapshot rather than only `server` because the counter surface
 * counts channels and roles out of it; every other adapter reads `server`.
 */
export interface SimulationScene {
  guildId: string;
  server: ServerFacts | null;
  guildState: GuildState | null;
  subject: SimulationPerson;
  actor: SimulationPerson;
  // Null while no channel is chosen and none is configured, which a preview shows on purpose:
  // the destination placeholders come out empty exactly as they would on the day.
  destinationChannel: ChannelFacts | null;
  originChannel: ChannelFacts | null;
  bot: BotFacts | null;
  eventId: string;
  now: number;

  // Honeypot substitutes its built-in layout for a free guild's authored one at render time, so a
  // rehearsal that did not know the tier would show a message that server never posts.
  tier: EntitlementTier;
  inputs: Readonly<Record<string, string | number | boolean>>;

  commandLabel?(key: string, path?: string): string;
}

export type SimulationOutput =
  | { kind: 'message'; message: ProtonMessage; attachments: SimulationAttachment[] }
  | { kind: 'text'; text: string };

export type SimulationBuild =
  | { ok: true; output: SimulationOutput; diagnostics: PathDiagnostic[]; caption: string }
  | { ok: false; humanReason: string; diagnostics: PathDiagnostic[] };

export interface SimulationAdapter<C = never> {
  descriptor: SimulationDescriptor;

  /**
   * The channel this variant would normally post in, read out of the module's own config. Separate
   * from `channelPath` because a module may pick a destination that no single key holds — Boost
   * falls back to wherever Discord put its own notice, and a scheduled message keeps its channel on
   * the template the inputs name.
   */
  destination?(
    config: C,
    inputs: Readonly<Record<string, string | number | boolean>>,
  ): string | null;

  build(config: C, scene: SimulationScene): SimulationBuild;
}
