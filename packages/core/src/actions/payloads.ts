import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

/** Discord's InteractionCallbackType.ChannelMessageWithSource. */
export const INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;
/** MessageFlags.Ephemeral (1<<6). */
export const MESSAGE_FLAG_EPHEMERAL = 64;

/** Bulk delete refuses more than this many messages in one call. */
export const BULK_DELETE_MAX = 100;
/** Bulk delete refuses messages older than 14 days. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Discord caps a timeout at 28 days. */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
/** Slowmode is 0–21600 seconds. */
export const MAX_SLOWMODE_SECONDS = 21_600;

export const sendPayloadSchema = z.object({
  channelId: snowflake,
  content: z.string().min(1).max(2000),
});

export const interactionReplyPayloadSchema = z.object({
  interactionId: snowflake,
  interactionToken: z.string().min(1),
  content: z.string().min(1).max(2000),
  ephemeral: z.boolean().default(false),
});

export const banPayloadSchema = z.object({
  userId: snowflake,
  /** Message history to purge on ban. Discord accepts 0–604800 seconds. */
  deleteMessageSeconds: z.number().int().min(0).max(604_800).default(0),
});

export const unbanPayloadSchema = z.object({ userId: snowflake });
export const kickPayloadSchema = z.object({ userId: snowflake });

export const timeoutPayloadSchema = z.object({
  userId: snowflake,
  /** Absolute expiry. Discord refuses anything beyond 28 days out. */
  until: z.date(),
});

export const untimeoutPayloadSchema = z.object({ userId: snowflake });

export const roleChangePayloadSchema = z.object({
  userId: snowflake,
  roleId: snowflake,
});

export const purgePayloadSchema = z.object({
  channelId: snowflake,
  messageIds: z.array(snowflake).min(2).max(BULK_DELETE_MAX),
});

export const slowmodePayloadSchema = z.object({
  channelId: snowflake,
  seconds: z.number().int().min(0).max(MAX_SLOWMODE_SECONDS),
});

/**
 * Lockdown writes a channel overwrite and **records what it replaced**.
 *
 * Without `previousAllow`/`previousDeny` an unlock cannot restore the channel
 * faithfully — it would have to guess, and guessing here silently rewrites a
 * server's permissions. See plan risk R4.
 */
export const lockdownPayloadSchema = z.object({
  channelId: snowflake,
  /** Usually the @everyone role, whose id equals the guild id. */
  roleId: snowflake,
  previousAllow: z.string().default('0'),
  previousDeny: z.string().default('0'),
});

export const unlockPayloadSchema = z.object({
  channelId: snowflake,
  roleId: snowflake,
  restoreAllow: z.string().default('0'),
  restoreDeny: z.string().default('0'),
});

export type SendPayload = z.infer<typeof sendPayloadSchema>;
export type InteractionReplyPayload = z.infer<typeof interactionReplyPayloadSchema>;
export type BanPayload = z.infer<typeof banPayloadSchema>;
export type TimeoutPayload = z.infer<typeof timeoutPayloadSchema>;
export type PurgePayload = z.infer<typeof purgePayloadSchema>;
export type LockdownPayload = z.infer<typeof lockdownPayloadSchema>;
