import type { ActionRow, MessageButton } from '../messages/components.ts';
import type { Embed } from '../messages/embed.ts';
import type { ContainerChild } from '../messages/v2.ts';
import { URL_MAX } from './limits.ts';
import type { ProtonMessageLike } from './message-fields.ts';

export const DISCORD_TEXT_LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  embedAuthor: 256,
  embedTotal: 6000,
  buttonLabel: 80,
  buttonUrl: 512,
  selectPlaceholder: 150,
  selectOptionLabel: 100,
  selectOptionDescription: 100,
  textDisplay: 4000,
  mediaDescription: 1024,
  channelName: 100,
} as const;

const LIMITS = DISCORD_TEXT_LIMITS;

const UNCLOSED_MARKUP = /<(?:@[!&]?|#|t:)[^>]*$/;

let segmenter: Intl.Segmenter | undefined;

function graphemeSegmenter(): Intl.Segmenter | undefined {
  // The types always declare Intl.Segmenter, but older browsers do not ship it.
  if (typeof Intl.Segmenter !== 'function') return undefined;
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return segmenter;
}

function units(text: string): Iterable<string> {
  const graphemes = graphemeSegmenter();
  if (graphemes === undefined) return text;
  return Array.from(graphemes.segment(text), ({ segment }) => segment);
}

export function clipGraphemes(text: string, max: number): string {
  if (Number.isNaN(max) || text.length <= max) return text;

  const limit = Math.max(0, Math.floor(max));
  let end = 0;

  for (const unit of units(text)) {
    if (end + unit.length > limit) break;
    end += unit.length;
  }

  const prefix = text.slice(0, end);
  const open = UNCLOSED_MARKUP.exec(prefix);
  return open === null ? prefix : prefix.slice(0, open.index);
}

export type LimitCode = 'output_truncated' | 'invalid_url';

export type LimitReport = (path: string, message: string, code?: LimitCode) => void;

interface Limiter {
  text(value: string, limit: number, path: string, label: string): string;
  link(value: string, limit: number, path: string, label: string): string;
}

function limiterFor(report: LimitReport): Limiter {
  return {
    text(value, limit, path, label) {
      const clipped = clipGraphemes(value, limit);
      if (clipped !== value) {
        report(
          path,
          `${label} passed Discord's limit of ${limit} characters once its placeholders were filled in, so the end was cut.`,
        );
      }
      return clipped;
    },
    link(value, limit, path, label) {
      if (value.length <= limit) return value;
      report(
        path,
        `${label} came to ${value.length} characters once its placeholders were filled in, past the limit of ${limit} for this link, so it is left empty.`,
        'invalid_url',
      );
      return '';
    },
  };
}

function optionalLink(
  value: string | undefined,
  path: string,
  label: string,
  limiter: Limiter,
): string | undefined {
  if (value === undefined) return undefined;
  const kept = limiter.link(value, URL_MAX, path, label);
  return kept === '' ? undefined : kept;
}

function limitEmbed(embed: Embed, base: string, limiter: Limiter): void {
  if (embed.title !== undefined) {
    embed.title = limiter.text(embed.title, LIMITS.embedTitle, `${base}.title`, 'The embed title');
  }
  if (embed.description !== undefined) {
    embed.description = limiter.text(
      embed.description,
      LIMITS.embedDescription,
      `${base}.description`,
      'The embed description',
    );
  }

  embed.url = optionalLink(embed.url, `${base}.url`, 'The embed title link', limiter);
  embed.imageUrl = optionalLink(embed.imageUrl, `${base}.imageUrl`, 'The embed image', limiter);
  embed.thumbnailUrl = optionalLink(
    embed.thumbnailUrl,
    `${base}.thumbnailUrl`,
    'The embed thumbnail',
    limiter,
  );

  if (embed.author !== undefined) {
    const { author } = embed;
    author.name = limiter.text(
      author.name,
      LIMITS.embedAuthor,
      `${base}.author.name`,
      'The embed author',
    );
    author.url = optionalLink(author.url, `${base}.author.url`, 'The embed author link', limiter);
    author.iconUrl = optionalLink(
      author.iconUrl,
      `${base}.author.iconUrl`,
      'The embed author icon',
      limiter,
    );
  }

  if (embed.footer !== undefined) {
    const { footer } = embed;
    footer.text = limiter.text(
      footer.text,
      LIMITS.embedFooter,
      `${base}.footer.text`,
      'The embed footer',
    );
    footer.iconUrl = optionalLink(
      footer.iconUrl,
      `${base}.footer.iconUrl`,
      'The embed footer icon',
      limiter,
    );
  }

  for (const [index, field] of (embed.fields ?? []).entries()) {
    const at = `${base}.fields.${index}`;
    field.name = limiter.text(
      field.name,
      LIMITS.embedFieldName,
      `${at}.name`,
      'The embed field name',
    );
    field.value = limiter.text(
      field.value,
      LIMITS.embedFieldValue,
      `${at}.value`,
      'The embed field text',
    );
  }
}

function counted(text: string | undefined): number {
  return text === undefined ? 0 : text.trim().length;
}

function embedsTotal(embeds: readonly Embed[]): number {
  return embeds.reduce(
    (total, embed) =>
      total +
      counted(embed.title) +
      counted(embed.description) +
      counted(embed.footer?.text) +
      counted(embed.author?.name) +
      (embed.fields ?? []).reduce(
        (sum, field) => sum + counted(field.name) + counted(field.value),
        0,
      ),
    0,
  );
}

interface Shortenable {
  path: string;
  label: string;
  floor: number;
  read(): string;
  write(next: string): void;
}

function shortenable(embeds: Embed[]): Shortenable[] {
  const newestFirst = [...embeds.entries()].reverse();
  const fieldsOf = (embed: Embed) => [...(embed.fields ?? []).entries()].reverse();
  const items: Shortenable[] = [];

  for (const [index, embed] of newestFirst) {
    if (embed.description === undefined) continue;
    items.push({
      path: `embeds.${index}.description`,
      label: 'the embed description',
      floor: 0,
      read: () => embed.description ?? '',
      write: (next) => {
        embed.description = next;
      },
    });
  }

  for (const [index, embed] of newestFirst) {
    for (const [at, field] of fieldsOf(embed)) {
      items.push({
        path: `embeds.${index}.fields.${at}.value`,
        label: 'the embed field text',
        floor: 1,
        read: () => field.value,
        write: (next) => {
          field.value = next;
        },
      });
    }
  }

  for (const [index, embed] of newestFirst) {
    const { footer } = embed;
    if (footer === undefined) continue;
    items.push({
      path: `embeds.${index}.footer.text`,
      label: 'the embed footer',
      floor: 0,
      read: () => footer.text,
      write: (next) => {
        footer.text = next;
      },
    });
  }

  for (const [index, embed] of newestFirst) {
    const { author } = embed;
    if (author === undefined) continue;
    items.push({
      path: `embeds.${index}.author.name`,
      label: 'the embed author',
      floor: 0,
      read: () => author.name,
      write: (next) => {
        author.name = next;
      },
    });
  }

  for (const [index, embed] of newestFirst) {
    for (const [at, field] of fieldsOf(embed)) {
      items.push({
        path: `embeds.${index}.fields.${at}.name`,
        label: 'the embed field name',
        floor: 1,
        read: () => field.name,
        write: (next) => {
          field.name = next;
        },
      });
    }
  }

  for (const [index, embed] of newestFirst) {
    if (embed.title === undefined) continue;
    items.push({
      path: `embeds.${index}.title`,
      label: 'the embed title',
      floor: 0,
      read: () => embed.title ?? '',
      write: (next) => {
        embed.title = next;
      },
    });
  }

  return items;
}

function limitEmbedTotal(embeds: Embed[], report: LimitReport): void {
  let total = embedsTotal(embeds);

  for (const item of total > LIMITS.embedTotal ? shortenable(embeds) : []) {
    if (total <= LIMITS.embedTotal) return;

    const trimmed = item.read().trim();
    const keep = Math.max(item.floor, trimmed.length - (total - LIMITS.embedTotal));
    if (keep >= trimmed.length) continue;

    item.write(clipGraphemes(trimmed, keep));
    report(
      item.path,
      `the embeds on this message came to ${total} characters once their placeholders were filled in, past Discord's limit of ${LIMITS.embedTotal} across all embeds, so ${item.label} was shortened.`,
    );
    total = embedsTotal(embeds);
  }
}

function limitButton(button: MessageButton, base: string, limiter: Limiter): void {
  if (button.label !== undefined) {
    button.label = limiter.text(
      button.label,
      LIMITS.buttonLabel,
      `${base}.label`,
      'The button label',
    );
  }
  if (button.url !== undefined) {
    button.url = limiter.link(button.url, LIMITS.buttonUrl, `${base}.url`, 'The button link');
  }
}

function limitRow(row: ActionRow, base: string, limiter: Limiter): void {
  if (row.kind === 'buttons') {
    for (const [index, button] of row.buttons.entries()) {
      limitButton(button, `${base}.buttons.${index}`, limiter);
    }
    return;
  }

  const { select } = row;
  if (select.placeholder !== undefined) {
    select.placeholder = limiter.text(
      select.placeholder,
      LIMITS.selectPlaceholder,
      `${base}.select.placeholder`,
      'The dropdown placeholder',
    );
  }

  for (const [index, option] of select.options.entries()) {
    const at = `${base}.select.options.${index}`;
    option.label = limiter.text(
      option.label,
      LIMITS.selectOptionLabel,
      `${at}.label`,
      'The dropdown option label',
    );
    if (option.description !== undefined) {
      option.description = limiter.text(
        option.description,
        LIMITS.selectOptionDescription,
        `${at}.description`,
        'The dropdown option description',
      );
    }
  }
}

function limitChild(child: ContainerChild, base: string, limiter: Limiter): void {
  switch (child.kind) {
    case 'text':
      child.content = limiter.text(
        child.content,
        LIMITS.textDisplay,
        `${base}.content`,
        'The text',
      );
      return;
    case 'section':
      child.text = child.text.map((line, index) =>
        limiter.text(line, LIMITS.textDisplay, `${base}.text.${index}`, 'The section line'),
      );
      if (child.accessory.kind === 'button') {
        limitButton(child.accessory.button, `${base}.accessory.button`, limiter);
      } else if (child.accessory.description !== undefined) {
        child.accessory.description = limiter.text(
          child.accessory.description,
          LIMITS.mediaDescription,
          `${base}.accessory.description`,
          'The section image description',
        );
      }
      return;
    case 'gallery':
      for (const [index, item] of child.items.entries()) {
        if (item.description === undefined) continue;
        item.description = limiter.text(
          item.description,
          LIMITS.mediaDescription,
          `${base}.items.${index}.description`,
          'The image description',
        );
      }
      return;
    case 'row':
      limitRow(child.row, `${base}.row`, limiter);
      return;
    case 'separator':
      return;
  }
}

export function enforceMessageLimits<M extends ProtonMessageLike>(
  message: M,
  report: LimitReport,
): M {
  const next = structuredClone(message);
  const limiter = limiterFor(report);

  if (next.content !== undefined) {
    next.content = limiter.text(next.content, LIMITS.content, 'content', 'The message text');
  }

  for (const [index, embed] of next.embeds.entries()) limitEmbed(embed, `embeds.${index}`, limiter);
  limitEmbedTotal(next.embeds, report);

  for (const [index, row] of next.components.entries()) {
    limitRow(row, `components.${index}`, limiter);
  }

  for (const [index, component] of (next.v2 ?? []).entries()) {
    if (component.kind !== 'container') {
      limitChild(component, `v2.${index}`, limiter);
      continue;
    }
    for (const [at, child] of component.children.entries()) {
      limitChild(child, `v2.${index}.children.${at}`, limiter);
    }
  }

  return next;
}
