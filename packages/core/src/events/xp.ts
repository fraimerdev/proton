import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const XP_SOURCES = ['message', 'voice', 'admin', 'reward'] as const;

export type XpSource = (typeof XP_SOURCES)[number];

export const CAUSATION_KINDS = ['organic', 'admin', 'reward', 'achievement'] as const;

export type CausationKind = (typeof CAUSATION_KINDS)[number];

export const causationSchema = z.object({
  kind: z.enum(CAUSATION_KINDS),
  rootId: z.string().min(1).max(200),
  depth: z.number().int().min(0).max(32),
  grantId: z.string().min(1).max(200).optional(),
  sourceModule: z.string().min(1).max(40).optional(),
});

export type Causation = z.infer<typeof causationSchema>;

export const xpAwardedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  amount: z.number().int().min(1),
  source: z.enum(XP_SOURCES),
  channelId: snowflakeSchema.optional(),
  activityAt: z.number().int(),
  xp: z.number().int().min(0),
  level: z.number().int().min(0),
  causation: causationSchema,
});

export type XpAwarded = z.infer<typeof xpAwardedSchema>;

export const xpLevelGainedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  level: z.number().int().min(0),
  previousLevel: z.number().int().min(0),
  xp: z.number().int().min(0),
  source: z.enum(XP_SOURCES),
  channelId: snowflakeSchema.optional(),
  causation: causationSchema.optional(),
});

export type XpLevelGained = z.infer<typeof xpLevelGainedSchema>;

export const XP_GRANT_MAX = 100_000;

export const xpGrantRequestedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  grantId: z.string().min(1).max(200),
  amount: z.number().int().min(1).max(XP_GRANT_MAX),
  reason: z.string().max(200),
  sourceModule: z.string().min(1).max(40),
  originChannelId: snowflakeSchema.optional(),
  causation: causationSchema,
});

export type XpGrantRequested = z.infer<typeof xpGrantRequestedSchema>;

export const XP_GRANT_STATUSES = ['granted', 'refused'] as const;

export type XpGrantStatus = (typeof XP_GRANT_STATUSES)[number];

export const xpGrantedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  grantId: z.string().min(1).max(200),
  sourceModule: z.string().min(1).max(40),
  status: z.enum(XP_GRANT_STATUSES),
  amount: z.number().int().min(0),
  reason: z.string().max(300).optional(),
  xp: z.number().int().optional(),
  level: z.number().int().optional(),
  previousLevel: z.number().int().optional(),
});

export type XpGranted = z.infer<typeof xpGrantedSchema>;
