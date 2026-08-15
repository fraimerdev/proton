import { z } from 'zod';

/**
 * A Discord id, wherever one is validated.
 *
 * Exported because rule conditions name channels and roles too, and two copies
 * of this regex would eventually disagree about what an id looks like.
 */
export const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

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

/** Discord's InteractionCallbackType.DeferredChannelMessageWithSource. */
export const INTERACTION_CALLBACK_DEFERRED_MESSAGE = 5;
/** DeferredMessageUpdate — acknowledge a component without a loading state. */
export const INTERACTION_CALLBACK_DEFERRED_UPDATE = 6;
/** UpdateMessage — edit the message the component is attached to. */
export const INTERACTION_CALLBACK_UPDATE_MESSAGE = 7;

/** Message components cap out at 40 per message; a custom_id is 1–100 chars. */
export const MAX_COMPONENTS_PER_MESSAGE = 40;
export const MAX_CUSTOM_ID_LENGTH = 100;
/** An action row holds at most five buttons. */
export const MAX_BUTTONS_PER_ROW = 5;

/**
 * Embeds and components pass through as opaque JSON.
 *
 * Modelling Discord's full embed and component grammar in Zod would be a second
 * source of truth for a shape Discord already validates and changes on its own
 * schedule — and getting it subtly wrong means refusing a payload Discord would
 * have accepted, with a validation error that names our schema rather than
 * anything the admin can act on. What is enforced here is only what Proton must
 * not get wrong: the arity limits, which produce a 400 with no useful message,
 * and the presence of *something* to send.
 */
const embedsSchema = z.array(z.record(z.string(), z.unknown())).max(10);
const componentsSchema = z.array(z.record(z.string(), z.unknown())).max(MAX_COMPONENTS_PER_MESSAGE);

/**
 * A file to upload alongside a message (§10, multipart).
 *
 * `data` is bytes, never a path or a URL: the executor is the only thing that
 * talks to the REST proxy, and handing it a path would make it read the
 * filesystem on a module's behalf.
 */
export const attachmentSchema = z.object({
  filename: z.string().min(1).max(256),
  contentType: z.string().min(1).max(128).default('application/octet-stream'),
  data: z.instanceof(Uint8Array),
  description: z.string().max(1024).optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * At least one of content, embeds, components or files must be present.
 *
 * Discord answers an empty message with a 400 whose body names neither the
 * field nor the caller, so the check is here where it can say which module sent
 * nothing.
 */
function hasSomethingToSend(value: {
  content?: string | undefined;
  embeds?: unknown[] | undefined;
  components?: unknown[] | undefined;
  files?: unknown[] | undefined;
}): boolean {
  return Boolean(
    value.content?.length ||
      value.embeds?.length ||
      value.components?.length ||
      value.files?.length,
  );
}

const NOTHING_TO_SEND =
  'a message needs content, an embed, a component or a file — this one has none of them.';

export const sendPayloadSchema = z
  .object({
    channelId: snowflakeSchema,
    // Optional since Gate 1: a starboard post is an embed with no content, and a
    // rank card is an attachment with no content.
    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
    files: z.array(attachmentSchema).max(10).optional(),
    /** Reply to this message, rather than posting standalone. */
    replyToMessageId: snowflakeSchema.optional(),
  })
  .refine(hasSomethingToSend, { message: NOTHING_TO_SEND });

export const editMessagePayloadSchema = z
  .object({
    channelId: snowflakeSchema,
    messageId: snowflakeSchema,
    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
  })
  .refine(hasSomethingToSend, { message: NOTHING_TO_SEND });

export const deleteMessagePayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
});

/**
 * `emoji` is the URL-encodable Discord form: `🌟` for unicode, `name:id` for a
 * custom one. Validated only for length — the set of valid unicode emoji is not
 * something to hard-code, and Discord rejects a bad one with a clear 400.
 */
export const addReactionPayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
  emoji: z.string().min(1).max(64),
});

export const interactionReplyPayloadSchema = z
  .object({
    interactionId: snowflakeSchema,
    interactionToken: z.string().min(1),
    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
    ephemeral: z.boolean().default(false),
    /**
     * Which callback type to answer with. Defaults to an immediate message.
     *
     * A deferral (5 or 6) carries no body, so it is the one case where having
     * nothing to send is correct — hence the refine below skips it.
     */
    callbackType: z
      .union([
        z.literal(INTERACTION_CALLBACK_CHANNEL_MESSAGE),
        z.literal(INTERACTION_CALLBACK_DEFERRED_MESSAGE),
        z.literal(INTERACTION_CALLBACK_DEFERRED_UPDATE),
        z.literal(INTERACTION_CALLBACK_UPDATE_MESSAGE),
      ])
      .default(INTERACTION_CALLBACK_CHANNEL_MESSAGE),
  })
  .refine((v) => isDeferral(v.callbackType) || hasSomethingToSend(v), { message: NOTHING_TO_SEND });

export function isDeferral(callbackType: number): boolean {
  return (
    callbackType === INTERACTION_CALLBACK_DEFERRED_MESSAGE ||
    callbackType === INTERACTION_CALLBACK_DEFERRED_UPDATE
  );
}

/**
 * A follow-up to an already-acknowledged interaction (I9).
 *
 * Separate from `interaction_reply` because it hits a different endpoint with a
 * different identity — the *application* id and the interaction token, not the
 * interaction id — and because the distinction is exactly the one an author gets
 * wrong: replying twice to one interaction 404s, and following up before
 * acknowledging does nothing. Two kinds make the sequence explicit.
 */
export const interactionFollowupPayloadSchema = z
  .object({
    applicationId: snowflakeSchema,
    interactionToken: z.string().min(1),
    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
    files: z.array(attachmentSchema).max(10).optional(),
    ephemeral: z.boolean().default(false),
  })
  .refine(hasSomethingToSend, { message: NOTHING_TO_SEND });

/**
 * A warn: a ledger row, no Discord call (see `LEDGER_ONLY_KINDS`).
 *
 * It still carries a `userId` so the prechecks have a target and the `cases` row
 * has someone to be about.
 */
export const warnPayloadSchema = z.object({
  userId: snowflakeSchema,
  /** Shown to the member if the module chooses to tell them; not sent by the executor. */
  note: z.string().max(1024).optional(),
});

export const banPayloadSchema = z.object({
  userId: snowflakeSchema,
  /** Message history to purge on ban. Discord accepts 0–604800 seconds. */
  deleteMessageSeconds: z.number().int().min(0).max(604_800).default(0),
});

export const unbanPayloadSchema = z.object({ userId: snowflakeSchema });
export const kickPayloadSchema = z.object({ userId: snowflakeSchema });

export const timeoutPayloadSchema = z.object({
  userId: snowflakeSchema,
  /** Absolute expiry. Discord refuses anything beyond 28 days out. */
  until: z.date(),
});

export const untimeoutPayloadSchema = z.object({ userId: snowflakeSchema });

export const roleChangePayloadSchema = z.object({
  userId: snowflakeSchema,
  roleId: snowflakeSchema,
});

export const purgePayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageIds: z.array(snowflakeSchema).min(2).max(BULK_DELETE_MAX),
});

export const slowmodePayloadSchema = z.object({
  channelId: snowflakeSchema,
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
  channelId: snowflakeSchema,
  /** Usually the @everyone role, whose id equals the guild id. */
  roleId: snowflakeSchema,
  previousAllow: z.string().default('0'),
  previousDeny: z.string().default('0'),
});

export const unlockPayloadSchema = z.object({
  channelId: snowflakeSchema,
  roleId: snowflakeSchema,
  restoreAllow: z.string().default('0'),
  restoreDeny: z.string().default('0'),
});

export type SendPayload = z.infer<typeof sendPayloadSchema>;
export type EditMessagePayload = z.infer<typeof editMessagePayloadSchema>;
export type DeleteMessagePayload = z.infer<typeof deleteMessagePayloadSchema>;
export type AddReactionPayload = z.infer<typeof addReactionPayloadSchema>;
export type InteractionReplyPayload = z.infer<typeof interactionReplyPayloadSchema>;
export type InteractionFollowupPayload = z.infer<typeof interactionFollowupPayloadSchema>;
export type WarnPayload = z.infer<typeof warnPayloadSchema>;
export type BanPayload = z.infer<typeof banPayloadSchema>;
export type TimeoutPayload = z.infer<typeof timeoutPayloadSchema>;
export type PurgePayload = z.infer<typeof purgePayloadSchema>;
export type LockdownPayload = z.infer<typeof lockdownPayloadSchema>;
