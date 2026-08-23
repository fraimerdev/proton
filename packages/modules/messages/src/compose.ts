import { encodeCustomId, type Modal } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { EMBED_TITLE_MAX, EMBED_URL_MAX, type EmbedContent, MODULE_ID } from './config.ts';
import { parseEmbedColour, parseEmbedLink } from './embed.ts';

export const SEND_ACTION = 'send';

export const TITLE_FIELD = 'title';
export const DESCRIPTION_FIELD = 'description';
export const COLOUR_FIELD = 'colour';
export const IMAGE_FIELD = 'image';

export const COMPOSER_TITLE = 'Compose an embed';

// Not EMBED_DESCRIPTION_MAX: a text input is capped at 4000, below the 4096 an embed allows, and
// Discord refuses to open a modal that asks for more.
const TEXT_INPUT_MAX = 4000;

const COLOUR_INPUT_MAX = 32;

export type ComposerModalResult = { ok: true; modal: Modal } | { ok: false; humanReason: string };

interface TextInput {
  customId: string;
  label: string;
  style: TextInputStyle;
  maxLength: number;
  placeholder: string;
}

const INPUTS: TextInput[] = [
  {
    customId: TITLE_FIELD,
    label: 'Title',
    style: TextInputStyle.Short,
    maxLength: EMBED_TITLE_MAX,
    placeholder: 'Server rules',
  },
  {
    customId: DESCRIPTION_FIELD,
    label: 'Description',
    style: TextInputStyle.Paragraph,
    maxLength: TEXT_INPUT_MAX,
    placeholder: 'Markdown works here.',
  },
  {
    customId: COLOUR_FIELD,
    label: 'Colour',
    style: TextInputStyle.Short,
    maxLength: COLOUR_INPUT_MAX,
    placeholder: '#5865F2',
  },
  {
    customId: IMAGE_FIELD,
    label: 'Image link',
    style: TextInputStyle.Short,
    maxLength: EMBED_URL_MAX,
    placeholder: 'https://example.com/banner.png',
  },
];

export function buildComposerModal(): ComposerModalResult {
  const encoded = encodeCustomId(MODULE_ID, SEND_ACTION);
  if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

  return {
    ok: true,
    modal: {
      customId: encoded.customId,
      title: COMPOSER_TITLE,
      components: INPUTS.map((input) => ({
        type: ComponentType.Label,
        label: input.label,
        component: {
          type: ComponentType.TextInput,
          custom_id: input.customId,
          style: input.style,
          required: false,
          max_length: input.maxLength,
          placeholder: input.placeholder,
        },
      })),
    },
  };
}

export type ComposedEmbedResult =
  | { ok: true; content: EmbedContent }
  | { ok: false; humanReason: string };

export function readComposedEmbed(fields: Record<string, string>): ComposedEmbedResult {
  const title = fields[TITLE_FIELD]?.trim() ?? '';
  const description = fields[DESCRIPTION_FIELD]?.trim() ?? '';

  const colour = parseEmbedColour(fields[COLOUR_FIELD]);
  if (!colour.ok) return { ok: false, humanReason: colour.humanReason };

  const image = parseEmbedLink(fields[IMAGE_FIELD], 'an embed’s image slot');
  if (!image.ok) return { ok: false, humanReason: image.humanReason };

  return {
    ok: true,
    content: {
      ...(title.length > 0 ? { title } : {}),
      ...(description.length > 0 ? { description } : {}),
      ...(colour.color === null ? {} : { color: colour.color }),
      ...(image.url === null ? {} : { imageUrl: image.url }),
    },
  };
}
