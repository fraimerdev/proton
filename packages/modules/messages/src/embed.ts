import {
  EMBED_AUTHOR_NAME_MAX,
  EMBED_COLOR_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
  type EmbedContent,
} from './config.ts';

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
  footer?: { text: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string };
  fields?: DiscordEmbedField[];
}

export type BuildEmbedResult =
  | { ok: true; embed: DiscordEmbed }
  | { ok: false; humanReason: string };

export interface BuildEmbedOptions {
  subject?: string;

  now?: Date;
}

export const DEFAULT_SUBJECT = 'That embed';

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

interface Normalised {
  title: string | undefined;
  description: string | undefined;
  url: string | undefined;
  imageUrl: string | undefined;
  thumbnailUrl: string | undefined;
  footer: string | undefined;
  authorName: string | undefined;
  fields: DiscordEmbedField[];
}

function normalise(content: EmbedContent): Normalised {
  return {
    title: text(content.title),
    description: text(content.description),
    url: text(content.url),
    imageUrl: text(content.imageUrl),
    thumbnailUrl: text(content.thumbnailUrl),
    footer: text(content.footer),
    authorName: text(content.authorName),
    fields: (content.fields ?? []).map((field) => ({
      name: field.name.trim(),
      value: field.value.trim(),
      ...(field.inline === undefined ? {} : { inline: field.inline }),
    })),
  };
}

function measure(normalised: Normalised): number {
  const fields = normalised.fields.reduce(
    (total, field) => total + field.name.length + field.value.length,
    0,
  );

  return (
    (normalised.title?.length ?? 0) +
    (normalised.description?.length ?? 0) +
    (normalised.footer?.length ?? 0) +
    (normalised.authorName?.length ?? 0) +
    fields
  );
}

export function embedLength(content: EmbedContent): number {
  return measure(normalise(content));
}

function overBy(subject: string, what: string, length: number, max: number): string {
  return (
    `${subject}’s ${what} is ${length} characters and Discord allows ${max}. ` +
    `Remove ${length - max}.`
  );
}

function capFailure(subject: string, normalised: Normalised): string | null {
  const scalars: Array<[string, string | undefined, number]> = [
    ['title', normalised.title, EMBED_TITLE_MAX],
    ['description', normalised.description, EMBED_DESCRIPTION_MAX],
    ['footer', normalised.footer, EMBED_FOOTER_MAX],
    ['author name', normalised.authorName, EMBED_AUTHOR_NAME_MAX],
  ];

  for (const [what, value, max] of scalars) {
    if (value !== undefined && value.length > max) return overBy(subject, what, value.length, max);
  }

  if (normalised.fields.length > EMBED_FIELDS_MAX) {
    return (
      `${subject} has ${normalised.fields.length} fields and Discord allows ` +
      `${EMBED_FIELDS_MAX}. Remove ${normalised.fields.length - EMBED_FIELDS_MAX}.`
    );
  }

  for (const [index, field] of normalised.fields.entries()) {
    const position = index + 1;

    if (field.name.length === 0) {
      return `${subject}’s field ${position} has no name, and Discord rejects a nameless field.`;
    }
    if (field.value.length === 0) {
      return `${subject}’s field ${position} has no text, and Discord rejects an empty field.`;
    }
    if (field.name.length > EMBED_FIELD_NAME_MAX) {
      return overBy(subject, `field ${position}’s name`, field.name.length, EMBED_FIELD_NAME_MAX);
    }
    if (field.value.length > EMBED_FIELD_VALUE_MAX) {
      return overBy(subject, `field ${position}’s text`, field.value.length, EMBED_FIELD_VALUE_MAX);
    }
  }

  return null;
}

function colourFailure(subject: string, color: number | undefined): string | null {
  if (color === undefined) return null;

  if (!Number.isInteger(color) || color < 0 || color > EMBED_COLOR_MAX) {
    return (
      `${subject} has a colour of ${color}, which is not a colour Discord takes — it wants a ` +
      `whole number from 0 to ${EMBED_COLOR_MAX} (#000000 to #ffffff).`
    );
  }

  return null;
}

function isEmpty(normalised: Normalised): boolean {
  return (
    normalised.title === undefined &&
    normalised.description === undefined &&
    normalised.footer === undefined &&
    normalised.authorName === undefined &&
    normalised.imageUrl === undefined &&
    normalised.thumbnailUrl === undefined &&
    normalised.fields.length === 0
  );
}

export function buildEmbed(
  content: EmbedContent,
  options: BuildEmbedOptions = {},
): BuildEmbedResult {
  const subject = options.subject ?? DEFAULT_SUBJECT;
  const normalised = normalise(content);

  const capped = capFailure(subject, normalised);
  if (capped) return { ok: false, humanReason: capped };

  const colour = colourFailure(subject, content.color);
  if (colour) return { ok: false, humanReason: colour };

  if (isEmpty(normalised)) {
    return {
      ok: false,
      humanReason:
        `${subject} has nothing in it. An embed needs at least a title, a description, one ` +
        'field, a footer, an author or an image before Discord will accept it.',
    };
  }

  const total = measure(normalised);
  if (total > EMBED_TOTAL_MAX) {
    return {
      ok: false,
      humanReason:
        `${subject} is ${total} characters and Discord allows ${EMBED_TOTAL_MAX} across an ` +
        'embed’s title, description, field names, field text, footer and author together. ' +
        `Remove ${total - EMBED_TOTAL_MAX} characters.`,
    };
  }

  const embed: DiscordEmbed = {
    ...(normalised.title === undefined ? {} : { title: normalised.title }),
    ...(normalised.description === undefined ? {} : { description: normalised.description }),
    ...(normalised.url === undefined ? {} : { url: normalised.url }),
    ...(content.color === undefined ? {} : { color: content.color }),
    ...(content.timestamp ? { timestamp: (options.now ?? new Date()).toISOString() } : {}),
    ...(normalised.footer === undefined ? {} : { footer: { text: normalised.footer } }),
    ...(normalised.imageUrl === undefined ? {} : { image: { url: normalised.imageUrl } }),
    ...(normalised.thumbnailUrl === undefined
      ? {}
      : { thumbnail: { url: normalised.thumbnailUrl } }),
    ...(normalised.authorName === undefined ? {} : { author: { name: normalised.authorName } }),
    ...(normalised.fields.length === 0 ? {} : { fields: normalised.fields }),
  };

  return { ok: true, embed };
}

export type ColourResult = { ok: true; color: number | null } | { ok: false; humanReason: string };

export function parseEmbedColour(raw: string | undefined): ColourResult {
  const value = raw?.trim() ?? '';
  if (value.length === 0) return { ok: true, color: null };

  const hex = value.replace(/^#/, '').replace(/^0x/i, '');

  // Hex before decimal: '123456' is a colour code to everyone who types one, and reading it as
  // decimal would silently post a near-black embed instead of the blue they picked.
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return { ok: true, color: Number.parseInt(hex, 16) };
  }

  if (/^\d+$/.test(value)) {
    const decimal = Number.parseInt(value, 10);
    if (decimal > EMBED_COLOR_MAX) {
      return {
        ok: false,
        humanReason:
          `${value} is past the brightest colour Discord takes (${EMBED_COLOR_MAX}, which is ` +
          '#ffffff). Use a hex code like #5865F2 instead.',
      };
    }
    return { ok: true, color: decimal };
  }

  return {
    ok: false,
    humanReason:
      `I could not read “${value}” as a colour. Use a six-digit hex code like #5865F2 or ` +
      '5865F2, or leave the colour blank.',
  };
}

export type LinkResult = { ok: true; url: string | null } | { ok: false; humanReason: string };

export function parseEmbedLink(raw: string | undefined, what: string): LinkResult {
  const value = raw?.trim() ?? '';
  if (value.length === 0) return { ok: true, url: null };

  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) {
    return {
      ok: false,
      humanReason:
        `“${value}” is not a link I can put in ${what}. Discord needs a complete address ` +
        'starting with http:// or https://.',
    };
  }

  return { ok: true, url: value };
}
