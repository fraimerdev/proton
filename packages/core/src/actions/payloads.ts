import { z } from 'zod';

export const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

export const INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;

export const MESSAGE_FLAG_EPHEMERAL = 64;

export const BULK_DELETE_MAX = 100;

export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export const MAX_SLOWMODE_SECONDS = 21_600;

export const INTERACTION_CALLBACK_DEFERRED_MESSAGE = 5;

export const INTERACTION_CALLBACK_DEFERRED_UPDATE = 6;

export const INTERACTION_CALLBACK_UPDATE_MESSAGE = 7;

export const MAX_COMPONENTS_PER_MESSAGE = 40;
export const MAX_CUSTOM_ID_LENGTH = 100;

export const MAX_BUTTONS_PER_ROW = 5;

const embedsSchema = z.array(z.record(z.string(), z.unknown())).max(10);
const componentsSchema = z.array(z.record(z.string(), z.unknown())).max(MAX_COMPONENTS_PER_MESSAGE);

export const attachmentSchema = z.object({
  filename: z.string().min(1).max(256),
  contentType: z.string().min(1).max(128).default('application/octet-stream'),
  data: z.instanceof(Uint8Array),
  description: z.string().max(1024).optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

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

export const MENTION_PARSE_KINDS = ['roles', 'users', 'everyone'] as const;

// Any message built from names a member controls — a channel name, a nickname, an audit-log
// value — can otherwise ping the server. `{ parse: [] }` still renders <@id>/<#id> as links.
export const allowedMentionsSchema = z.object({
  parse: z.array(z.enum(MENTION_PARSE_KINDS)).max(MENTION_PARSE_KINDS.length),
  roles: z.array(snowflakeSchema).max(100).optional(),
  users: z.array(snowflakeSchema).max(100).optional(),
  replied_user: z.boolean().optional(),
});

export type AllowedMentions = z.infer<typeof allowedMentionsSchema>;

export const sendPayloadSchema = z
  .object({
    channelId: snowflakeSchema,

    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
    files: z.array(attachmentSchema).max(10).optional(),

    allowedMentions: allowedMentionsSchema.optional(),

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
    files: z.array(attachmentSchema).max(10).optional(),
    ephemeral: z.boolean().default(false),

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

export const warnPayloadSchema = z.object({
  userId: snowflakeSchema,

  note: z.string().max(1024).optional(),
});

export const banPayloadSchema = z.object({
  userId: snowflakeSchema,

  deleteMessageSeconds: z.number().int().min(0).max(604_800).default(0),
});

export const unbanPayloadSchema = z.object({ userId: snowflakeSchema });
export const kickPayloadSchema = z.object({ userId: snowflakeSchema });

export const timeoutPayloadSchema = z.object({
  userId: snowflakeSchema,

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

export const lockdownPayloadSchema = z.object({
  channelId: snowflakeSchema,

  roleId: snowflakeSchema,
  previousAllow: z.string().default('0'),
  previousDeny: z.string().default('0'),
});

// Restore recreates what a backup snapshotted, so these mirror the snapshot's own shape rather
// than Discord's full create bodies — anything a restore cannot faithfully reproduce is reported
// as skipped instead of being guessed at.
export const createChannelPayloadSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.number().int().min(0).max(16),
  parentId: snowflakeSchema.optional(),
  position: z.number().int().min(0).optional(),
  topic: z.string().max(1024).optional(),
  nsfw: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(MAX_SLOWMODE_SECONDS).optional(),
});

export const createRolePayloadSchema = z.object({
  name: z.string().min(1).max(100),
  // A decimal string, never a number: role permissions exceed Number.MAX_SAFE_INTEGER.
  permissions: z.string().regex(/^\d+$/).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

export const unlockPayloadSchema = z.object({
  channelId: snowflakeSchema,
  roleId: snowflakeSchema,
  restoreAllow: z.string().default('0'),
  restoreDeny: z.string().default('0'),
});

export const AUTOMOD_EVENT_MESSAGE_SEND = 1 as const;
export const AUTOMOD_EVENT_MEMBER_UPDATE = 2 as const;

export const AUTOMOD_TRIGGER_KEYWORD = 1 as const;
export const AUTOMOD_TRIGGER_SPAM = 3 as const;
export const AUTOMOD_TRIGGER_KEYWORD_PRESET = 4 as const;
export const AUTOMOD_TRIGGER_MENTION_SPAM = 5 as const;
export const AUTOMOD_TRIGGER_MEMBER_PROFILE = 6 as const;

export const AUTOMOD_ACTION_BLOCK_MESSAGE = 1 as const;
export const AUTOMOD_ACTION_SEND_ALERT = 2 as const;
export const AUTOMOD_ACTION_TIMEOUT = 3 as const;
export const AUTOMOD_ACTION_BLOCK_INTERACTION = 4 as const;

export const AUTOMOD_PRESET_PROFANITY = 1 as const;
export const AUTOMOD_PRESET_SEXUAL_CONTENT = 2 as const;
export const AUTOMOD_PRESET_SLURS = 3 as const;

// Discord's own caps, mirrored so a rule is rejected here with a readable message rather than by
// the API with an index into an array.
export const AUTOMOD_MAX_KEYWORDS = 1000;
export const AUTOMOD_MAX_KEYWORD_LENGTH = 60;
export const AUTOMOD_MAX_REGEX_PATTERNS = 10;
export const AUTOMOD_MAX_REGEX_LENGTH = 260;
export const AUTOMOD_MAX_ALLOW_LIST = 1000;
export const AUTOMOD_MAX_MENTIONS = 50;
export const AUTOMOD_MAX_CUSTOM_MESSAGE = 150;
export const AUTOMOD_MAX_TIMEOUT_SECONDS = 2_419_200;
export const AUTOMOD_MAX_EXEMPT_ROLES = 20;
export const AUTOMOD_MAX_EXEMPT_CHANNELS = 50;
export const AUTOMOD_MAX_KEYWORD_RULES = 6;

const automodActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(AUTOMOD_ACTION_BLOCK_MESSAGE),
    customMessage: z.string().max(AUTOMOD_MAX_CUSTOM_MESSAGE).optional(),
  }),
  z.object({ type: z.literal(AUTOMOD_ACTION_SEND_ALERT), channelId: snowflakeSchema }),
  z.object({
    type: z.literal(AUTOMOD_ACTION_TIMEOUT),
    durationSeconds: z.number().int().min(1).max(AUTOMOD_MAX_TIMEOUT_SECONDS),
  }),
  z.object({ type: z.literal(AUTOMOD_ACTION_BLOCK_INTERACTION) }),
]);

export type AutomodRuleAction = z.infer<typeof automodActionSchema>;

const automodTriggerMetadataSchema = z.object({
  keywordFilter: z
    .array(z.string().min(1).max(AUTOMOD_MAX_KEYWORD_LENGTH))
    .max(AUTOMOD_MAX_KEYWORDS)
    .optional(),
  // Rust syntax, not JavaScript's: no lookaround and no backreferences. Whatever builds this has
  // already decided the pattern survives the translation.
  regexPatterns: z
    .array(z.string().min(1).max(AUTOMOD_MAX_REGEX_LENGTH))
    .max(AUTOMOD_MAX_REGEX_PATTERNS)
    .optional(),
  presets: z
    .array(
      z.union([
        z.literal(AUTOMOD_PRESET_PROFANITY),
        z.literal(AUTOMOD_PRESET_SEXUAL_CONTENT),
        z.literal(AUTOMOD_PRESET_SLURS),
      ]),
    )
    .max(3)
    .optional(),
  allowList: z
    .array(z.string().min(1).max(AUTOMOD_MAX_KEYWORD_LENGTH))
    .max(AUTOMOD_MAX_ALLOW_LIST)
    .optional(),
  mentionTotalLimit: z.number().int().min(1).max(AUTOMOD_MAX_MENTIONS).optional(),
  mentionRaidProtectionEnabled: z.boolean().optional(),
});

export type AutomodTriggerMetadata = z.infer<typeof automodTriggerMetadataSchema>;

const automodRuleSpecShape = {
  name: z.string().min(1).max(100),
  eventType: z
    .union([z.literal(AUTOMOD_EVENT_MESSAGE_SEND), z.literal(AUTOMOD_EVENT_MEMBER_UPDATE)])
    .default(AUTOMOD_EVENT_MESSAGE_SEND),
  triggerMetadata: automodTriggerMetadataSchema.default({}),
  actions: z.array(automodActionSchema).min(1).max(3),
  enabled: z.boolean().default(true),
  exemptRoles: z.array(snowflakeSchema).max(AUTOMOD_MAX_EXEMPT_ROLES).default([]),
  exemptChannels: z.array(snowflakeSchema).max(AUTOMOD_MAX_EXEMPT_CHANNELS).default([]),
};

export const automodRuleCreatePayloadSchema = z.object({
  ...automodRuleSpecShape,
  triggerType: z.union([
    z.literal(AUTOMOD_TRIGGER_KEYWORD),
    z.literal(AUTOMOD_TRIGGER_SPAM),
    z.literal(AUTOMOD_TRIGGER_KEYWORD_PRESET),
    z.literal(AUTOMOD_TRIGGER_MENTION_SPAM),
    z.literal(AUTOMOD_TRIGGER_MEMBER_PROFILE),
  ]),
});

// No triggerType: Discord rejects a PATCH that carries it, so changing a rule's trigger means
// deleting it and creating a new one.
export const automodRuleUpdatePayloadSchema = z.object({
  ...automodRuleSpecShape,
  ruleId: snowflakeSchema,
});

export const automodRuleDeletePayloadSchema = z.object({ ruleId: snowflakeSchema });

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
export type CreateChannelPayload = z.infer<typeof createChannelPayloadSchema>;
export type CreateRolePayload = z.infer<typeof createRolePayloadSchema>;
export type AutomodRuleCreatePayload = z.infer<typeof automodRuleCreatePayloadSchema>;
export type AutomodRuleUpdatePayload = z.infer<typeof automodRuleUpdatePayloadSchema>;
export type AutomodRuleDeletePayload = z.infer<typeof automodRuleDeletePayloadSchema>;
