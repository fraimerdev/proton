import { z } from 'zod';

export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_FOOTER_TEXT_MAX = 2048;
export const EMBED_AUTHOR_NAME_MAX = 256;
export const EMBED_FIELDS_MAX = 25;
export const EMBED_COLOR_MAX = 0xffffff;

// Across every embed on one message, not per embed:
// https://docs.discord.com/developers/resources/message#embed-object-embed-limits
export const EMBED_TOTAL_MAX = 6000;

export const EMBEDS_PER_MESSAGE_MAX = 10;

// Proton's own ceiling. Discord documents no length limit on an embed's URLs, so this must never
// be reported to an admin as something Discord refused.
export const EMBED_URL_MAX = 2048;

export const embedLinkSchema = z
  .string()
  .max(EMBED_URL_MAX)
  .refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), {
    message: 'must be a complete http:// or https:// link',
  });

export const embedFieldSchema = z.object({
  name: z.string().trim().min(1).max(EMBED_FIELD_NAME_MAX),
  value: z.string().trim().min(1).max(EMBED_FIELD_VALUE_MAX),
  inline: z.boolean().optional(),
});

export type EmbedField = z.infer<typeof embedFieldSchema>;

export const embedAuthorSchema = z.object({
  name: z.string().trim().min(1).max(EMBED_AUTHOR_NAME_MAX),
  url: embedLinkSchema.optional(),
  iconUrl: embedLinkSchema.optional(),
});

export type EmbedAuthor = z.infer<typeof embedAuthorSchema>;

export const embedFooterSchema = z.object({
  text: z.string().trim().min(1).max(EMBED_FOOTER_TEXT_MAX),
  iconUrl: embedLinkSchema.optional(),
});

export type EmbedFooter = z.infer<typeof embedFooterSchema>;

export const embedSchema = z.object({
  title: z.string().max(EMBED_TITLE_MAX).optional(),
  description: z.string().max(EMBED_DESCRIPTION_MAX).optional(),
  url: embedLinkSchema.optional(),
  color: z.number().int().min(0).max(EMBED_COLOR_MAX).optional(),
  timestamp: z.union([z.literal('now'), z.iso.datetime({ offset: true })]).optional(),
  author: embedAuthorSchema.optional(),
  footer: embedFooterSchema.optional(),
  imageUrl: embedLinkSchema.optional(),
  thumbnailUrl: embedLinkSchema.optional(),
  fields: z.array(embedFieldSchema).max(EMBED_FIELDS_MAX).optional(),
});

export type Embed = z.infer<typeof embedSchema>;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: DiscordEmbedField[];
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

// Discord trims before it counts, so a raw character count disagrees with the API at the boundary.
export function embedLength(embed: Embed): number {
  const fields = (embed.fields ?? []).reduce(
    (total, field) => total + field.name.trim().length + field.value.trim().length,
    0,
  );

  return (
    (text(embed.title)?.length ?? 0) +
    (text(embed.description)?.length ?? 0) +
    (text(embed.footer?.text)?.length ?? 0) +
    (text(embed.author?.name)?.length ?? 0) +
    fields
  );
}

export function embedsLength(embeds: readonly Embed[]): number {
  return embeds.reduce((total, embed) => total + embedLength(embed), 0);
}

export function isEmptyEmbed(embed: Embed): boolean {
  return (
    text(embed.title) === undefined &&
    text(embed.description) === undefined &&
    text(embed.footer?.text) === undefined &&
    text(embed.author?.name) === undefined &&
    text(embed.imageUrl) === undefined &&
    text(embed.thumbnailUrl) === undefined &&
    (embed.fields ?? []).length === 0
  );
}

export function toDiscordEmbed(embed: Embed, now: Date = new Date()): DiscordEmbed {
  const title = text(embed.title);
  const description = text(embed.description);
  const url = text(embed.url);
  const image = text(embed.imageUrl);
  const thumbnail = text(embed.thumbnailUrl);
  const author = embed.author ? text(embed.author.name) : undefined;
  const footer = embed.footer ? text(embed.footer.text) : undefined;
  const timestamp = embed.timestamp === 'now' ? now.toISOString() : embed.timestamp;

  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(embed.color === undefined ? {} : { color: embed.color }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(footer === undefined || embed.footer === undefined
      ? {}
      : {
          footer: {
            text: footer,
            ...(embed.footer.iconUrl === undefined ? {} : { icon_url: embed.footer.iconUrl }),
          },
        }),
    ...(image === undefined ? {} : { image: { url: image } }),
    ...(thumbnail === undefined ? {} : { thumbnail: { url: thumbnail } }),
    ...(author === undefined || embed.author === undefined
      ? {}
      : {
          author: {
            name: author,
            ...(embed.author.url === undefined ? {} : { url: embed.author.url }),
            ...(embed.author.iconUrl === undefined ? {} : { icon_url: embed.author.iconUrl }),
          },
        }),
    ...((embed.fields ?? []).length === 0
      ? {}
      : {
          fields: (embed.fields ?? []).map((field) => ({
            name: field.name.trim(),
            value: field.value.trim(),
            ...(field.inline === undefined ? {} : { inline: field.inline }),
          })),
        }),
  };
}
