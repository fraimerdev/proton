import { z } from 'zod';

export const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

export const INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;

export const MESSAGE_FLAG_EPHEMERAL = 64;

export const MESSAGE_FLAG_IS_COMPONENTS_V2 = 32768;

export const BULK_DELETE_MAX = 100;

export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export const MAX_SLOWMODE_SECONDS = 21_600;

export const INTERACTION_CALLBACK_DEFERRED_MESSAGE = 5;

export const INTERACTION_CALLBACK_DEFERRED_UPDATE = 6;

export const INTERACTION_CALLBACK_UPDATE_MESSAGE = 7;

export const INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT = 8;

export const INTERACTION_CALLBACK_MODAL = 9;

export const INTERACTION_TYPE_MODAL_SUBMIT = 5;

export const MAX_COMPONENTS_PER_MESSAGE = 40;
export const MAX_COMPONENTS_PER_MODAL = 5;
export const MAX_CUSTOM_ID_LENGTH = 100;

export const MAX_BUTTONS_PER_ROW = 5;

export const MAX_MODAL_TITLE_LENGTH = 45;

export const MAX_AUTOCOMPLETE_CHOICES = 25;
export const MAX_AUTOCOMPLETE_CHOICE_LENGTH = 100;

export const POLL_MAX_QUESTION_LENGTH = 300;
export const POLL_MAX_ANSWERS = 10;
export const POLL_MAX_ANSWER_LENGTH = 55;
export const POLL_MAX_DURATION_HOURS = 768;

export const MAX_CHANNEL_USER_LIMIT = 10_000;
export const MIN_CHANNEL_BITRATE = 8_000;
export const MAX_CHANNEL_BITRATE = 384_000;

export const THREAD_TYPE_PUBLIC = 11;
export const THREAD_TYPE_PRIVATE = 12;

const embedsSchema = z.array(z.record(z.string(), z.unknown())).max(10);
const componentsSchema = z.array(z.record(z.string(), z.unknown())).max(MAX_COMPONENTS_PER_MESSAGE);
const modalComponentsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(MAX_COMPONENTS_PER_MODAL, `a modal holds at most ${MAX_COMPONENTS_PER_MODAL} components.`);

// looseObject, not object: a stripping object would silently drop poll fields Discord needs.
const pollAnswerSchema = z.looseObject({
  poll_media: z.looseObject({
    text: z
      .string()
      .max(
        POLL_MAX_ANSWER_LENGTH,
        `a poll answer is capped at ${POLL_MAX_ANSWER_LENGTH} characters.`,
      ),
  }),
});

const pollSchema = z.looseObject({
  question: z.looseObject({
    text: z
      .string()
      .max(
        POLL_MAX_QUESTION_LENGTH,
        `a poll question is capped at ${POLL_MAX_QUESTION_LENGTH} characters.`,
      ),
  }),
  answers: z
    .array(pollAnswerSchema)
    .min(1)
    .max(POLL_MAX_ANSWERS, `a poll takes at most ${POLL_MAX_ANSWERS} answers.`),
  duration: z
    .number()
    .int()
    .positive()
    .max(
      POLL_MAX_DURATION_HOURS,
      `a poll runs for at most ${POLL_MAX_DURATION_HOURS} hours (32 days).`,
    )
    .optional(),
  allow_multiselect: z.boolean().optional(),
  layout_type: z.number().int().optional(),
});

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
  poll?: unknown;
}): boolean {
  return Boolean(
    value.content?.length ||
      value.embeds?.length ||
      value.components?.length ||
      value.files?.length ||
      value.poll,
  );
}

const NOTHING_TO_SEND =
  'a message needs content, an embed, a component, a file or a poll — this one has none of them.';

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

// Under IS_COMPONENTS_V2 Discord rejects content, embeds, sticker_ids and poll outright with a
// 400. Catching it here names the field; catching it at the proxy is an opaque Bad Request from
// inside a debounced edit loop nobody is watching.
const COMPONENTS_V2_CONFLICT =
  'a Components V2 message is built entirely from components: content, embeds and poll are ' +
  'refused by Discord when the IS_COMPONENTS_V2 flag is set. Use a Text Display component ' +
  'instead of content, and a Container instead of an embed.';

function componentsV2IsExclusive(payload: {
  flags?: number | undefined;
  content?: string | undefined;
  embeds?: unknown[] | undefined;
  poll?: unknown;
  components?: unknown[] | undefined;
}): boolean {
  if (((payload.flags ?? 0) & MESSAGE_FLAG_IS_COMPONENTS_V2) === 0) return true;

  return (
    payload.content === undefined &&
    payload.embeds === undefined &&
    payload.poll === undefined &&
    (payload.components?.length ?? 0) > 0
  );
}

export const sendPayloadSchema = z
  .object({
    channelId: snowflakeSchema,

    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
    files: z.array(attachmentSchema).max(10).optional(),
    poll: pollSchema.optional(),
    flags: z.number().int().optional(),

    allowedMentions: allowedMentionsSchema.optional(),

    replyToMessageId: snowflakeSchema.optional(),
  })
  .refine(hasSomethingToSend, { message: NOTHING_TO_SEND })
  .refine(componentsV2IsExclusive, { message: COMPONENTS_V2_CONFLICT });

export const editMessagePayloadSchema = z
  .object({
    channelId: snowflakeSchema,
    messageId: snowflakeSchema,
    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),

    // Only ever set, never cleared — Discord refuses to take IS_COMPONENTS_V2 off a message.
    flags: z.number().int().optional(),
  })
  .refine(hasSomethingToSend, { message: NOTHING_TO_SEND })
  .refine(componentsV2IsExclusive, { message: COMPONENTS_V2_CONFLICT });

export const deleteMessagePayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
});

export const addReactionPayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
  emoji: z.string().min(1).max(64),
});

export const modalSchema = z.object({
  customId: z.string().min(1).max(MAX_CUSTOM_ID_LENGTH),
  title: z.string().min(1).max(MAX_MODAL_TITLE_LENGTH),
  components: modalComponentsSchema,
});

export const autocompleteChoiceSchema = z.object({
  name: z.string().min(1).max(MAX_AUTOCOMPLETE_CHOICE_LENGTH),
  value: z.union([z.string().max(MAX_AUTOCOMPLETE_CHOICE_LENGTH), z.number()]),
});

const MODAL_ON_MODAL_SUBMIT =
  'Discord will not open a modal in response to a modal submission (interaction type 5). ' +
  'Reply with a message or a deferred update instead, and open the next modal from a component.';

export const interactionReplyPayloadSchema = z
  .object({
    interactionId: snowflakeSchema,
    interactionToken: z.string().min(1),
    content: z.string().max(2000).optional(),
    embeds: embedsSchema.optional(),
    components: componentsSchema.optional(),
    files: z.array(attachmentSchema).max(10).optional(),
    ephemeral: z.boolean().default(false),

    flags: z.number().int().optional(),

    allowedMentions: allowedMentionsSchema.optional(),

    modal: modalSchema.optional(),
    choices: z.array(autocompleteChoiceSchema).max(MAX_AUTOCOMPLETE_CHOICES).optional(),

    sourceInteractionType: z.number().int().optional(),

    callbackType: z
      .union([
        z.literal(INTERACTION_CALLBACK_CHANNEL_MESSAGE),
        z.literal(INTERACTION_CALLBACK_DEFERRED_MESSAGE),
        z.literal(INTERACTION_CALLBACK_DEFERRED_UPDATE),
        z.literal(INTERACTION_CALLBACK_UPDATE_MESSAGE),
        z.literal(INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT),
        z.literal(INTERACTION_CALLBACK_MODAL),
      ])
      .default(INTERACTION_CALLBACK_CHANNEL_MESSAGE),
  })
  .refine((v) => v.callbackType !== INTERACTION_CALLBACK_MODAL || v.modal !== undefined, {
    message: 'a modal response carries no modal.',
    path: ['modal'],
  })
  .refine(
    (v) => v.callbackType !== INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT || v.choices !== undefined,
    { message: 'an autocomplete response carries no choices.', path: ['choices'] },
  )
  .refine(
    (v) =>
      v.callbackType !== INTERACTION_CALLBACK_MODAL ||
      v.sourceInteractionType !== INTERACTION_TYPE_MODAL_SUBMIT,
    { message: MODAL_ON_MODAL_SUBMIT, path: ['callbackType'] },
  )
  .refine(componentsV2IsExclusive, { message: COMPONENTS_V2_CONFLICT })
  .refine((v) => !carriesMessage(v.callbackType) || hasSomethingToSend(v), {
    message: NOTHING_TO_SEND,
  });

export function isDeferral(callbackType: number): boolean {
  return (
    callbackType === INTERACTION_CALLBACK_DEFERRED_MESSAGE ||
    callbackType === INTERACTION_CALLBACK_DEFERRED_UPDATE
  );
}

export function carriesMessage(callbackType: number): boolean {
  return (
    callbackType === INTERACTION_CALLBACK_CHANNEL_MESSAGE ||
    callbackType === INTERACTION_CALLBACK_UPDATE_MESSAGE
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

    flags: z.number().int().optional(),

    allowedMentions: allowedMentionsSchema.optional(),
  })
  .refine(hasSomethingToSend, { message: NOTHING_TO_SEND })
  .refine(componentsV2IsExclusive, { message: COMPONENTS_V2_CONFLICT });

export const warnPayloadSchema = z.object({
  userId: snowflakeSchema,

  note: z.string().max(1024).optional(),
});

export const giveawayDrawPayloadSchema = z.object({
  giveawayId: z.string().min(1).max(64),
  drawNumber: z.number().int().min(1),

  seed: z.string().min(1).max(64),
  snapshotHash: z.string().min(1).max(128),

  entrantCount: z.number().int().min(0),
  totalEntries: z.number().int().min(0),

  winnerIds: z.array(snowflakeSchema).max(100),
  degradedProviders: z.array(z.string().max(100)).max(50).optional(),
  disqualified: z.number().int().min(0).optional(),
});

export const createDmPayloadSchema = z.object({ userId: snowflakeSchema });

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

export const permissionOverwriteSchema = z.object({
  id: snowflakeSchema,
  type: z.union([z.literal(0), z.literal(1)]),
  allow: z.string().regex(/^\d+$/).optional(),
  deny: z.string().regex(/^\d+$/).optional(),
});

export type PermissionOverwriteSpec = z.infer<typeof permissionOverwriteSchema>;

export const MAX_PERMISSION_OVERWRITES = 100;

// Restore recreates what a backup snapshotted, so the first seven fields mirror the snapshot's own
// shape rather than Discord's full create body — anything a restore cannot faithfully reproduce is
// reported as skipped instead of being guessed at. The rest exist because a ticket channel has to
// be private in the same call that creates it: create-then-patch leaves it world-readable for the
// width of one round trip.
export const createChannelPayloadSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.number().int().min(0).max(16),
  parentId: snowflakeSchema.optional(),
  position: z.number().int().min(0).optional(),
  topic: z.string().max(1024).optional(),
  nsfw: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(MAX_SLOWMODE_SECONDS).optional(),

  permissionOverwrites: z
    .array(permissionOverwriteSchema)
    .max(MAX_PERMISSION_OVERWRITES)
    .optional(),
  userLimit: z.number().int().min(0).max(MAX_CHANNEL_USER_LIMIT).optional(),
  bitrate: z.number().int().min(MIN_CHANNEL_BITRATE).max(MAX_CHANNEL_BITRATE).optional(),
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

export const deleteChannelPayloadSchema = z.object({ channelId: snowflakeSchema });

// One overwrite at a time, unlike edit_channel, which replaces the whole array: two people adding
// somebody to the same ticket at once would otherwise each write back the array they read before
// the other, and the slower write would revoke the faster one.
export const setChannelOverwritePayloadSchema = z.object({
  channelId: snowflakeSchema,
  overwriteId: snowflakeSchema,
  type: z.union([z.literal(0), z.literal(1)]),
  allow: z.string().regex(/^\d+$/).default('0'),
  deny: z.string().regex(/^\d+$/).default('0'),
});

export const deleteChannelOverwritePayloadSchema = z.object({
  channelId: snowflakeSchema,
  overwriteId: snowflakeSchema,
});

export const editChannelPayloadSchema = z.object({
  channelId: snowflakeSchema,
  name: z.string().min(1).max(100).optional(),
  userLimit: z.number().int().min(0).max(MAX_CHANNEL_USER_LIMIT).optional(),
  bitrate: z.number().int().min(MIN_CHANNEL_BITRATE).max(MAX_CHANNEL_BITRATE).optional(),
  topic: z.string().max(1024).optional(),
  parentId: snowflakeSchema.optional(),
  rateLimitPerUser: z.number().int().min(0).max(MAX_SLOWMODE_SECONDS).optional(),
  permissionOverwrites: z.array(permissionOverwriteSchema).optional(),
});

export const createThreadPayloadSchema = z.object({
  channelId: snowflakeSchema,
  name: z.string().min(1).max(100),
  type: z.union([z.literal(THREAD_TYPE_PUBLIC), z.literal(THREAD_TYPE_PRIVATE)]),
  autoArchiveDuration: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .optional(),
  invitable: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(MAX_SLOWMODE_SECONDS).optional(),
});

export const moveMemberPayloadSchema = z.object({
  userId: snowflakeSchema,
  channelId: snowflakeSchema,
});

export const endPollPayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
});

export const pinMessagePayloadSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
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
export type GiveawayDrawPayload = z.infer<typeof giveawayDrawPayloadSchema>;
export type CreateDmPayload = z.infer<typeof createDmPayloadSchema>;
export type TimeoutPayload = z.infer<typeof timeoutPayloadSchema>;
export type PurgePayload = z.infer<typeof purgePayloadSchema>;
export type LockdownPayload = z.infer<typeof lockdownPayloadSchema>;
export type CreateChannelPayload = z.infer<typeof createChannelPayloadSchema>;
export type CreateRolePayload = z.infer<typeof createRolePayloadSchema>;
export type DeleteChannelPayload = z.infer<typeof deleteChannelPayloadSchema>;
export type SetChannelOverwritePayload = z.infer<typeof setChannelOverwritePayloadSchema>;
export type DeleteChannelOverwritePayload = z.infer<typeof deleteChannelOverwritePayloadSchema>;
export type EditChannelPayload = z.infer<typeof editChannelPayloadSchema>;
export type CreateThreadPayload = z.infer<typeof createThreadPayloadSchema>;
export type MoveMemberPayload = z.infer<typeof moveMemberPayloadSchema>;
export type EndPollPayload = z.infer<typeof endPollPayloadSchema>;
export type PinMessagePayload = z.infer<typeof pinMessagePayloadSchema>;
export type Modal = z.infer<typeof modalSchema>;
export type AutocompleteChoice = z.infer<typeof autocompleteChoiceSchema>;
export type AutomodRuleCreatePayload = z.infer<typeof automodRuleCreatePayloadSchema>;
export type AutomodRuleUpdatePayload = z.infer<typeof automodRuleUpdatePayloadSchema>;
export type AutomodRuleDeletePayload = z.infer<typeof automodRuleDeletePayloadSchema>;
