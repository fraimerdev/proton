import { z } from 'zod';
import { type AllowedMentions, MESSAGE_FLAG_IS_COMPONENTS_V2 } from '../actions/payloads.ts';
import { MESSAGE_CONTENT_MAX } from '../interactions/respond.ts';
import {
  type ActionRow,
  actionRowsSchema,
  type CustomIdFor,
  type DiscordComponent,
  rowKeys,
  toDiscordComponents,
} from './components.ts';
import {
  type DiscordEmbed,
  EMBED_TOTAL_MAX,
  EMBEDS_PER_MESSAGE_MAX,
  type Embed,
  embedSchema,
  embedsLength,
  isEmptyEmbed,
  toDiscordEmbed,
} from './embed.ts';
import {
  toDiscordV2Components,
  type V2Component,
  v2AccessoryButtons,
  v2ComponentsSchema,
  v2Rows,
} from './v2.ts';

export const mentionPolicySchema = z.object({
  everyone: z.boolean().default(false),
  roles: z.boolean().default(true),
  users: z.boolean().default(true),
});

export type MentionPolicy = z.infer<typeof mentionPolicySchema>;

export const DEFAULT_MENTION_POLICY: MentionPolicy = {
  everyone: false,
  roles: true,
  users: true,
};

// Always explicit, never omitted: Discord's default for a bot message parses everything, so a
// message built from a name a member controls could otherwise ping the whole server.
export function toAllowedMentions(policy: MentionPolicy = DEFAULT_MENTION_POLICY): AllowedMentions {
  const parse: Array<'roles' | 'users' | 'everyone'> = [];
  if (policy.roles) parse.push('roles');
  if (policy.users) parse.push('users');
  if (policy.everyone) parse.push('everyone');

  return { parse };
}

const NOTHING_TO_SEND =
  'this message has nothing in it — give it text, an embed or a component before it can be sent.';

export const messageShape = {
  content: z.string().max(MESSAGE_CONTENT_MAX).optional(),
  embeds: z.array(embedSchema).max(EMBEDS_PER_MESSAGE_MAX).default([]),
  components: actionRowsSchema.default([]),
  mentions: mentionPolicySchema.default(DEFAULT_MENTION_POLICY),

  // A sibling key rather than a mode discriminator: z.discriminatedUnion reads the raw tag before
  // defaults apply, so every message stored without one would fail to parse and take welcome,
  // leveling and /embed post offline at once.
  v2: v2ComponentsSchema.default([]),
};

export const messageObjectSchema = z.object(messageShape);

// Exported apart from messageSchema so a module can add its own keys — superRefine returns a type
// that can no longer be extended, so the refinement has to be reappliable to the wider object.
export function refineMessage(
  message: {
    content?: string | undefined;
    embeds: Embed[];
    components: unknown[];
    v2?: V2Component[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  {
    const hasContent = (message.content?.trim().length ?? 0) > 0;
    const v2 = message.v2 ?? [];

    if (v2.length > 0) {
      // Discord refuses the whole message, not just the offending field, so this has to be an
      // error at save time rather than something the send path quietly drops.
      const carried: string[] = [];
      if (hasContent) carried.push('text');
      if (message.embeds.length > 0) carried.push('an embed');
      if (message.components.length > 0) carried.push('a plain button row');

      if (carried.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['v2'],
          message:
            `a components-v2 layout is the whole message, and this one also carries ` +
            `${carried.join(' and ')}. Discord refuses that outright — move the ${carried[0]} into ` +
            'a text display, or switch the layout off.',
        });
      }

      // Rows nest inside containers here, so the per-array uniqueness actionRowsSchema applies is
      // no longer enough: a press only carries its key, and two components sharing one is unroutable.
      const keys = [...v2Rows(v2).flatMap(rowKeys), ...v2AccessoryButtons(v2)];
      const seen = new Set<string>();

      for (const key of keys) {
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['v2'],
            message:
              `two components in this layout are both keyed '${key}'. The key is what a press ` +
              'carries back, so Proton could not tell which one was pressed.',
          });
        }
        seen.add(key);
      }

      return;
    }

    if (!hasContent && message.embeds.length === 0 && message.components.length === 0) {
      ctx.addIssue({ code: 'custom', message: NOTHING_TO_SEND });
    }

    for (const [index, embed] of message.embeds.entries()) {
      if (isEmptyEmbed(embed)) {
        ctx.addIssue({
          code: 'custom',
          path: ['embeds', index],
          message:
            'this embed has nothing in it. An embed needs at least a title, a description, one ' +
            'field, a footer, an author or an image before Discord will accept it.',
        });
      }
    }

    const total = embedsLength(message.embeds);
    if (total > EMBED_TOTAL_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['embeds'],
        message:
          `the embeds on this message come to ${total} characters and Discord allows ` +
          `${EMBED_TOTAL_MAX} across every embed's title, description, field names, field text, ` +
          `footer and author together. Remove ${total - EMBED_TOTAL_MAX} characters.`,
      });
    }

    // Discord deduplicates embeds by url and shows only the first, so a repeat would vanish
    // silently after posting.
    const urls = new Map<string, number>();
    for (const [index, embed] of message.embeds.entries()) {
      if (!embed.url) continue;

      const first = urls.get(embed.url);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['embeds', index, 'url'],
          message:
            `embed ${index + 1} carries the same link as embed ${first + 1}. Discord shows only ` +
            'the first embed of any one link, so this one would never appear.',
        });
      }
      urls.set(embed.url, index);
    }
  }
}

export const messageSchema = messageObjectSchema.superRefine(refineMessage);

export type ProtonMessage = z.infer<typeof messageSchema>;

export const EMPTY_MESSAGE: ProtonMessage = {
  content: undefined,
  embeds: [],
  components: [],
  mentions: DEFAULT_MENTION_POLICY,
  v2: [],
};

const LEGACY_EMBED_KEYS = [
  'title',
  'description',
  'url',
  'color',
  'imageUrl',
  'thumbnailUrl',
  'footer',
  'authorName',
  'timestamp',
  'fields',
] as const;

// A stored entry written before the builder held one flat embed. Zod strips unknown keys, so
// without lifting them here a plain re-parse would return an empty message and the next write
// would persist that loss.
export function liftLegacyMessage(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  const source = value as Record<string, unknown>;
  if (
    Object.hasOwn(source, 'embeds') ||
    Object.hasOwn(source, 'components') ||
    Object.hasOwn(source, 'v2')
  ) {
    return value;
  }

  const legacy = LEGACY_EMBED_KEYS.filter((key) => Object.hasOwn(source, key));
  if (legacy.length === 0) return value;

  const embed: Record<string, unknown> = {};
  for (const key of legacy) {
    const held = source[key];
    if (held === undefined || held === null) continue;

    if (key === 'footer') embed.footer = { text: held };
    else if (key === 'authorName') embed.author = { name: held };
    else if (key === 'timestamp') {
      if (held === true) embed.timestamp = 'now';
    } else embed[key] = held;
  }

  const rest = Object.fromEntries(
    Object.entries(source).filter(([key]) => !LEGACY_EMBED_KEYS.includes(key as never)),
  );

  return { ...rest, embeds: Object.keys(embed).length > 0 ? [embed] : [] };
}

export const storedMessageSchema = z.preprocess(liftLegacyMessage, messageSchema);

export interface ToDiscordMessageOptions {
  customIdFor: CustomIdFor;
  now?: Date;
}

export interface DiscordMessageBody {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordComponent[];
  flags?: number;
  allowedMentions: AllowedMentions;
}

export function isComponentsV2(message: ProtonMessage): boolean {
  return message.v2.length > 0;
}

// Counts a v2 tree as well as the classic rows: a button nested in a container or hung off a
// section is just as unanswerable to a module with no interaction listener as a top-level one.
export function interactiveKeys(message: {
  components: ActionRow[];
  v2?: V2Component[] | undefined;
}): string[] {
  const v2 = message.v2 ?? [];

  return [
    ...message.components.flatMap(rowKeys),
    ...v2Rows(v2).flatMap(rowKeys),
    ...v2AccessoryButtons(v2),
  ];
}

export function toDiscordMessage(
  message: ProtonMessage,
  options: ToDiscordMessageOptions,
): DiscordMessageBody {
  const content = message.content?.trim();
  const now = options.now ?? new Date();

  if (isComponentsV2(message)) {
    return {
      components: toDiscordV2Components(message.v2, options.customIdFor),
      flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
      allowedMentions: toAllowedMentions(message.mentions),
    };
  }

  return {
    ...(content ? { content } : {}),
    ...(message.embeds.length === 0
      ? {}
      : { embeds: message.embeds.map((embed: Embed) => toDiscordEmbed(embed, now)) }),
    ...(message.components.length === 0
      ? {}
      : { components: toDiscordComponents(message.components, options.customIdFor) }),
    allowedMentions: toAllowedMentions(message.mentions),
  };
}
