import { z } from 'zod';
import {
  type ActionRow,
  actionRowSchema,
  type CustomIdFor,
  type DiscordComponent,
  messageButtonSchema,
  toDiscordComponents,
} from './components.ts';

export const COMPONENT_TYPE_SECTION = 9;
export const COMPONENT_TYPE_TEXT_DISPLAY = 10;
export const COMPONENT_TYPE_THUMBNAIL = 11;
export const COMPONENT_TYPE_MEDIA_GALLERY = 12;
export const COMPONENT_TYPE_SEPARATOR = 14;
export const COMPONENT_TYPE_CONTAINER = 17;

export const V2_COMPONENTS_MAX = 40;

export const SECTION_TEXT_MAX = 3;
export const MEDIA_GALLERY_ITEMS_MAX = 10;
export const MEDIA_DESCRIPTION_MAX = 1024;
export const CONTAINER_ACCENT_MAX = 0xffffff;

export const SEPARATOR_SPACINGS = ['small', 'large'] as const;
export type SeparatorSpacing = (typeof SEPARATOR_SPACINGS)[number];

export const SEPARATOR_SPACING_VALUES: Readonly<Record<SeparatorSpacing, number>> = {
  small: 1,
  large: 2,
};

// Discord documents no length limit on a media url, so this checks the scheme only — a cap here
// would refuse links Discord accepts.
const mediaLinkSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), {
    message: 'must be a complete http:// or https:// link',
  });

export const textDisplaySchema = z.object({
  kind: z.literal('text'),
  content: z.string().trim().min(1),
});

export const separatorSchema = z.object({
  kind: z.literal('separator'),
  divider: z.boolean().default(true),
  spacing: z.enum(SEPARATOR_SPACINGS).default('small'),
});

export const mediaItemSchema = z.object({
  url: mediaLinkSchema,
  description: z.string().trim().max(MEDIA_DESCRIPTION_MAX).optional(),
  spoiler: z.boolean().optional(),
});

export type MediaItem = z.infer<typeof mediaItemSchema>;

export const mediaGallerySchema = z.object({
  kind: z.literal('gallery'),
  items: z.array(mediaItemSchema).min(1).max(MEDIA_GALLERY_ITEMS_MAX),
});

export const thumbnailAccessorySchema = z.object({
  kind: z.literal('thumbnail'),
  url: mediaLinkSchema,
  description: z.string().trim().max(MEDIA_DESCRIPTION_MAX).optional(),
  spoiler: z.boolean().optional(),
});

export const buttonAccessorySchema = z.object({
  kind: z.literal('button'),
  button: messageButtonSchema,
});

export const sectionAccessorySchema = z.discriminatedUnion('kind', [
  thumbnailAccessorySchema,
  buttonAccessorySchema,
]);

export type SectionAccessory = z.infer<typeof sectionAccessorySchema>;

// The accessory is required, not optional: Discord's Section structure table carries no `?` on it,
// and a section without one is refused rather than silently rendered as a bare text display.
export const sectionSchema = z.object({
  kind: z.literal('section'),
  text: z.array(z.string().trim().min(1)).min(1).max(SECTION_TEXT_MAX),
  accessory: sectionAccessorySchema,
});

export const componentRowSchema = z.object({
  kind: z.literal('row'),
  row: actionRowSchema,
});

export const containerChildSchema = z.discriminatedUnion('kind', [
  textDisplaySchema,
  separatorSchema,
  mediaGallerySchema,
  sectionSchema,
  componentRowSchema,
]);

export type ContainerChild = z.infer<typeof containerChildSchema>;

// A container is top-level only — Discord does not list it among any component's children — so the
// tree is exactly two deep and needs no recursive schema.
export const containerSchema = z.object({
  kind: z.literal('container'),
  accentColor: z.number().int().min(0).max(CONTAINER_ACCENT_MAX).optional(),
  spoiler: z.boolean().optional(),
  children: z.array(containerChildSchema).min(1),
});

export const v2ComponentSchema = z.discriminatedUnion('kind', [
  textDisplaySchema,
  separatorSchema,
  mediaGallerySchema,
  sectionSchema,
  componentRowSchema,
  containerSchema,
]);

export type V2Component = z.infer<typeof v2ComponentSchema>;

function countChild(child: ContainerChild): number {
  if (child.kind === 'section') return 1 + child.text.length + 1;
  if (child.kind === 'row')
    return 1 + (child.row.kind === 'buttons' ? child.row.buttons.length : 1);
  return 1;
}

// Discord counts every component object in the tree against the 40 cap, so a top-level array cap
// would stop guarding the moment one container held the whole message.
export function countV2Components(components: readonly V2Component[]): number {
  return components.reduce((total, component) => {
    if (component.kind === 'container') {
      return total + 1 + component.children.reduce((sum, child) => sum + countChild(child), 0);
    }
    return total + countChild(component);
  }, 0);
}

export function v2Rows(components: readonly V2Component[]): ActionRow[] {
  const rows: ActionRow[] = [];

  for (const component of components) {
    if (component.kind === 'row') rows.push(component.row);
    if (component.kind === 'container') {
      for (const child of component.children) {
        if (child.kind === 'row') rows.push(child.row);
      }
    }
  }

  return rows;
}

export function v2AccessoryButtons(components: readonly V2Component[]): string[] {
  const keys: string[] = [];

  const fromSection = (section: Extract<V2Component, { kind: 'section' }>): void => {
    if (section.accessory.kind === 'button' && section.accessory.button.style !== 'link') {
      keys.push(section.accessory.button.key);
    }
  };

  for (const component of components) {
    if (component.kind === 'section') fromSection(component);
    if (component.kind === 'container') {
      for (const child of component.children) {
        if (child.kind === 'section') fromSection(child);
      }
    }
  }

  return keys;
}

export const v2ComponentsSchema = z.array(v2ComponentSchema).superRefine((components, ctx) => {
  const total = countV2Components(components);

  if (total > V2_COMPONENTS_MAX) {
    ctx.addIssue({
      code: 'custom',
      message:
        `this layout comes to ${total} components and Discord allows ${V2_COMPONENTS_MAX} across ` +
        `the whole message. Remove ${total - V2_COMPONENTS_MAX}.`,
    });
  }
});

function toDiscordChild(child: ContainerChild, customIdFor: CustomIdFor): DiscordComponent {
  switch (child.kind) {
    case 'text':
      return { type: COMPONENT_TYPE_TEXT_DISPLAY, content: child.content };

    case 'separator':
      return {
        type: COMPONENT_TYPE_SEPARATOR,
        divider: child.divider,
        spacing: SEPARATOR_SPACING_VALUES[child.spacing],
      };

    case 'gallery':
      return {
        type: COMPONENT_TYPE_MEDIA_GALLERY,
        items: child.items.map((item) => ({
          media: { url: item.url },
          ...(item.description ? { description: item.description } : {}),
          ...(item.spoiler ? { spoiler: true } : {}),
        })),
      };

    case 'section':
      return {
        type: COMPONENT_TYPE_SECTION,
        components: child.text.map((content) => ({
          type: COMPONENT_TYPE_TEXT_DISPLAY,
          content,
        })),
        accessory:
          child.accessory.kind === 'thumbnail'
            ? {
                type: COMPONENT_TYPE_THUMBNAIL,
                media: { url: child.accessory.url },
                ...(child.accessory.description
                  ? { description: child.accessory.description }
                  : {}),
                ...(child.accessory.spoiler ? { spoiler: true } : {}),
              }
            : (toDiscordComponents(
                [{ kind: 'buttons', buttons: [child.accessory.button] }],
                customIdFor,
              )[0]?.components?.[0] as DiscordComponent),
      };

    case 'row':
      return toDiscordComponents([child.row], customIdFor)[0] as DiscordComponent;
  }
}

export function toDiscordV2Components(
  components: readonly V2Component[],
  customIdFor: CustomIdFor,
): DiscordComponent[] {
  return components.map((component) => {
    if (component.kind !== 'container') return toDiscordChild(component, customIdFor);

    return {
      type: COMPONENT_TYPE_CONTAINER,
      ...(component.accentColor === undefined ? {} : { accent_color: component.accentColor }),
      ...(component.spoiler ? { spoiler: true } : {}),
      components: component.children.map((child) => toDiscordChild(child, customIdFor)),
    };
  });
}
