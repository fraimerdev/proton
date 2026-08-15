/**
 * The Discord shapes this module reads, and the pure functions that read them.
 *
 * Everything here is a translation from what Discord sends to what `decide.ts`
 * reasons about. Nothing in this file talks to Discord, Redis or Postgres, which
 * is what lets the emoji matching and the attachment picking be tested against
 * plain objects.
 */

/**
 * A custom emoji has an id and a name; a unicode one has only a name.
 *
 * Kept as a pair rather than collapsed to a string because the two halves are
 * matched independently — see `sameEmoji`.
 */
export interface EmojiRef {
  id: string | null;
  name: string | null;
}

/** The star-relevant slice of a MESSAGE_REACTION_ADD / _REMOVE dispatch. */
export interface StarReaction {
  channelId: string;
  messageId: string;
  userId: string;
  emoji: EmojiRef;
}

export interface SourceAttachment {
  url: string;
  filename: string;
  /** Discord's `content_type`, absent for older attachments. */
  contentType: string | null;
}

export interface SourceReaction {
  emoji: EmojiRef;
  count: number;
}

/**
 * The message a reaction is about, as this module needs it.
 *
 * A module-defined struct rather than Discord's message object, in the same
 * spirit as `backup`'s `GuildLayout`: the port that fetches it is a dumb REST
 * wrapper, and everything that has to be *decided* from it happens here where it
 * can be tested. `readSourceMessage` below builds one from a raw Discord message
 * so a binder does not have to reimplement that mapping.
 */
export interface SourceMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorBot: boolean;
  /** What the embed's author line says — a display name, not a mention. */
  authorName: string;
  /** Absolute CDN URL, or null when the account has no avatar set. */
  authorAvatarUrl: string | null;
  content: string;
  attachments: readonly SourceAttachment[];
  reactions: readonly SourceReaction[];
  /**
   * Whether the message's channel is age-restricted.
   *
   * **Not on Discord's message object** — verified against the message resource
   * reference, which lists no `nsfw` field. So the binder supplies it from the
   * channel, and a binder that cannot must say `false` rather than guess: see
   * the note on `ignoreNsfw` in the manifest.
   */
  channelNsfw: boolean;
  /**
   * Who reacted with the requested emoji, when the caller asked for it.
   *
   * Null means "not resolved", which is the ordinary case: the reaction object
   * Discord returns carries `count`, `count_details`, `me`, `me_burst`, `emoji`
   * and `burst_colors` (verified) and names nobody, so the reactor list is a
   * second endpoint and a second round trip. Only a guild that bars self-stars
   * needs it.
   */
  starredBy: readonly string[] | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readEmoji(value: unknown): EmojiRef | null {
  const raw = record(value);
  if (!raw) return null;

  const ref: EmojiRef = { id: str(raw.id), name: str(raw.name) };
  return ref.id === null && ref.name === null ? null : ref;
}

/**
 * Pull the reaction out of a raw dispatch payload.
 *
 * The gateway hands listeners the raw Discord object, so this is one of two
 * places in the module that knows Discord's shape. Returns null rather than
 * throwing on anything unreadable: a payload this cannot parse is one the module
 * could not act on anyway, and throwing would have the bus redeliver it forever.
 */
export function readReaction(payload: unknown): StarReaction | null {
  const raw = record(payload);
  if (!raw) return null;

  const channelId = str(raw.channel_id);
  const messageId = str(raw.message_id);
  const userId = str(raw.user_id);
  const emoji = readEmoji(raw.emoji);

  if (!channelId || !messageId || !userId || !emoji) return null;
  return { channelId, messageId, userId, emoji };
}

/**
 * Read a config `emoji` value into the pair a reaction carries.
 *
 * Accepts `<:name:id>` and `<a:name:id>` — the form Discord's client puts on the
 * clipboard — as well as the bare `name:id` the REST API wants, because an admin
 * filling this field in will paste whichever one they have to hand.
 */
export function parseEmoji(value: string): EmojiRef {
  const trimmed = value.trim();

  const tagged = /^<a?:([^:]+):(\d{17,20})>$/.exec(trimmed);
  if (tagged) return { name: tagged[1] ?? null, id: tagged[2] ?? null };

  const pair = /^([^:]+):(\d{17,20})$/.exec(trimmed);
  if (pair) return { name: pair[1] ?? null, id: pair[2] ?? null };

  // A bare snowflake: the id alone identifies a custom emoji, and matching by id
  // is exact, so there is nothing to lose by accepting it.
  if (/^\d{17,20}$/.test(trimmed)) return { id: trimmed, name: null };

  return { id: null, name: trimmed };
}

/**
 * Whether a reaction is the one a guild configured.
 *
 * Id first, because two custom emoji in a server may share a name and the id is
 * what Discord actually keys on. Falling back to the name is what makes a config
 * value of just `:partyparrot:` work, and what keeps a guild's setting valid
 * after the emoji is deleted and re-uploaded under the same name.
 */
export function sameEmoji(reaction: EmojiRef, configured: EmojiRef): boolean {
  if (reaction.id !== null && configured.id !== null) return reaction.id === configured.id;
  if (reaction.name !== null && configured.name !== null) return reaction.name === configured.name;
  return false;
}

/** How a custom emoji is written inside message content, so the board line renders it. */
export function emojiDisplay(emoji: EmojiRef): string {
  if (emoji.id !== null) return `<:${emoji.name ?? '_'}:${emoji.id}>`;
  return emoji.name ?? '';
}

/**
 * How Discord's REST API names an emoji in a path segment: `name:id` for a
 * custom one, the character itself for a unicode one. Not the same as
 * `emojiDisplay` — the angle-bracket form is a message-content convention and
 * would 400 in a URL.
 */
export function emojiRestForm(emoji: EmojiRef): string {
  if (emoji.id !== null) return `${emoji.name ?? '_'}:${emoji.id}`;
  return emoji.name ?? '';
}

/** How many members reacted with `configured`, before any self-star rule. */
export function rawStarCount(message: SourceMessage, configured: EmojiRef): number {
  for (const reaction of message.reactions) {
    if (sameEmoji(reaction.emoji, configured)) return reaction.count;
  }
  return 0;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * The attachment the board post shows, if any.
 *
 * `content_type` first because it is what Discord actually determined; the
 * filename suffix is the fallback for attachments uploaded before Discord
 * started reporting it, which are exactly the old messages a starboard gets
 * pointed at when a server first turns it on.
 */
export function firstImage(attachments: readonly SourceAttachment[]): SourceAttachment | undefined {
  return attachments.find((attachment) => {
    if (attachment.contentType?.startsWith('image/')) return true;
    const name = attachment.filename.toLowerCase();
    return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
  });
}

/** Discord's CDN path for a user avatar. Animated hashes are prefixed `a_`. */
function avatarUrl(userId: string, hash: string | null): string | null {
  if (hash === null) return null;
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${extension}?size=128`;
}

export interface SourceMessageExtras {
  /** See `SourceMessage.channelNsfw` — Discord's message object does not carry it. */
  channelNsfw: boolean;
  /** See `SourceMessage.starredBy`. Omit it when the reactor list was not fetched. */
  starredBy?: readonly string[] | null;
}

/**
 * Build a `SourceMessage` from a raw Discord message object.
 *
 * Exported for the process that binds `readMessage`: without it, the mapping
 * from Discord's shape to this module's would live in `apps/worker`, one import
 * boundary away from the tests that check it. The port stays a REST call and
 * this stays the only description of what a starred message looks like.
 *
 * Null for anything unreadable, for the same reason `readReaction` returns null.
 */
export function readSourceMessage(raw: unknown, extras: SourceMessageExtras): SourceMessage | null {
  const message = record(raw);
  if (!message) return null;

  const id = str(message.id);
  const channelId = str(message.channel_id);
  const author = record(message.author);
  const authorId = author ? str(author.id) : null;

  if (!id || !channelId || !author || !authorId) return null;

  const attachments = Array.isArray(message.attachments)
    ? message.attachments.flatMap((entry): SourceAttachment[] => {
        const attachment = record(entry);
        const url = attachment ? str(attachment.url) : null;
        if (!attachment || !url) return [];
        return [
          {
            url,
            filename: str(attachment.filename) ?? '',
            contentType: str(attachment.content_type),
          },
        ];
      })
    : [];

  const reactions = Array.isArray(message.reactions)
    ? message.reactions.flatMap((entry): SourceReaction[] => {
        const reaction = record(entry);
        const emoji = reaction ? readEmoji(reaction.emoji) : null;
        if (!reaction || !emoji || typeof reaction.count !== 'number') return [];
        return [{ emoji, count: reaction.count }];
      })
    : [];

  return {
    id,
    channelId,
    authorId,
    // `webhook_id` is how a webhook post is told apart from a member's, and a
    // webhook's `author.bot` is true, so the flag alone would already catch it —
    // but only the id survives on a message posted by a webhook Proton did not
    // create, so both are checked.
    authorBot: author.bot === true || str(message.webhook_id) !== null,
    authorName: str(author.global_name) ?? str(author.username) ?? authorId,
    authorAvatarUrl: avatarUrl(authorId, str(author.avatar)),
    content: typeof message.content === 'string' ? message.content : '',
    attachments,
    reactions,
    channelNsfw: extras.channelNsfw,
    starredBy: extras.starredBy ?? null,
  };
}
