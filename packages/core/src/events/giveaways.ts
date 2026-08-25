import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

const base = {
  guildId: snowflakeSchema,
  giveawayId: z.string().min(1).max(64),

  /** The short public code (`7X29`), absent on rows created before short codes existed. */
  shortCode: z.string().min(1).max(16).nullable(),

  title: z.string().min(1).max(200),
  channelId: snowflakeSchema,
  hostId: snowflakeSchema,
};

export const giveawayCreatedEventSchema = z.object({
  ...base,
  createdById: snowflakeSchema,
  winnerCount: z.number().int().min(1),
  endsAt: z.number().int(),
  startsAt: z.number().int().nullable(),
  requirementCount: z.number().int().min(0),
  multiplierCount: z.number().int().min(0),
});

export const giveawayStartedEventSchema = z.object({
  ...base,
  endsAt: z.number().int(),
});

export const giveawayEditedEventSchema = z.object({
  ...base,
  actorId: snowflakeSchema,

  // Only the fields that actually moved, so a log line can say what changed rather than restating
  // the whole giveaway.
  changed: z.array(z.string().min(1).max(40)).max(20),
  endsAtBefore: z.number().int().nullable(),
  endsAtAfter: z.number().int().nullable(),
});

export const giveawayPausedEventSchema = z.object({
  ...base,
  actorId: snowflakeSchema,
  reason: z.string().max(200).nullable(),
});

export const giveawayResumedEventSchema = z.object({
  ...base,
  actorId: snowflakeSchema,
  endsAt: z.number().int(),
  heldMs: z.number().int().min(0),
});

export const giveawayCancelledEventSchema = z.object({
  ...base,
  actorId: snowflakeSchema,
  entrantCount: z.number().int().min(0),
});

const drawn = {
  ...base,
  drawNumber: z.number().int().min(1),
  drawnById: snowflakeSchema.or(z.string().min(1).max(64)),
  winnerIds: z.array(snowflakeSchema).max(50),
  entrantCount: z.number().int().min(0),
  totalEntries: z.number().int().min(0),
  disqualified: z.number().int().min(0),
  degradedProviders: z.array(z.string().min(1).max(80)).max(20),

  /** Enough to reproduce the draw from its audit row without opening the database. */
  seed: z.string().min(1).max(64),
  snapshotHash: z.string().min(1).max(128),
};

export const giveawayEndedEventSchema = z.object(drawn);
export const giveawayRerolledEventSchema = z.object({
  ...drawn,
  replacedIds: z.array(snowflakeSchema).max(50),
});

export const giveawayBonusGrantedEventSchema = z.object({
  ...base,
  actorId: snowflakeSchema,
  subjectId: snowflakeSchema,
  amount: z.number().int(),
  reason: z.string().max(200).nullable(),
  revoked: z.boolean(),
});

export type GiveawayCreatedEvent = z.infer<typeof giveawayCreatedEventSchema>;
export type GiveawayStartedEvent = z.infer<typeof giveawayStartedEventSchema>;
export type GiveawayEditedEvent = z.infer<typeof giveawayEditedEventSchema>;
export type GiveawayPausedEvent = z.infer<typeof giveawayPausedEventSchema>;
export type GiveawayResumedEvent = z.infer<typeof giveawayResumedEventSchema>;
export type GiveawayCancelledEvent = z.infer<typeof giveawayCancelledEventSchema>;
export type GiveawayEndedEvent = z.infer<typeof giveawayEndedEventSchema>;
export type GiveawayRerolledEvent = z.infer<typeof giveawayRerolledEventSchema>;
export type GiveawayBonusGrantedEvent = z.infer<typeof giveawayBonusGrantedEventSchema>;
