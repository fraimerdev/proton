import type { EmojiSet } from './emoji.ts';

export const TITLE_MAX = 256;
export const DESCRIPTION_MAX = 4096;
export const FIELD_VALUE_MAX = 1024;
export const FIELD_NAME_MAX = 256;
export const FOOTER_MAX = 2048;
export const INLINE_VALUE_MAX = 200;

export interface LogLine {
  label: string;
  mention?: string | undefined;
  value?: string | undefined;
}

export interface LogField {
  name: string;
  value: string;
}

export interface LogExecutor {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface LogEmbedInput {
  subject: string;
  action: string;
  colour: number;
  lines: readonly LogLine[];
  fields?: readonly LogField[];
  executor: LogExecutor | null;
  occurredAt: number;
  emojis: EmojiSet;
}

// A backtick in a channel name or nickname would close the code span and corrupt every line
// after it, so it is swapped for a modifier letter that looks the same and has no markup meaning.
export function escapeInline(value: string): string {
  return value.replaceAll('`', 'ˋ').slice(0, INLINE_VALUE_MAX);
}

export function logLine(emoji: string, line: LogLine): string {
  const mention = line.mention ? ` ${line.mention}` : '';
  const value = line.value === undefined ? '' : ` \`${escapeInline(line.value)}\``;

  return `${emoji} **${line.label}:**${mention}${value}`;
}

export function logBody(lines: readonly LogLine[], emojis: EmojiSet): string {
  return lines
    .map((line, index) => logLine(index === lines.length - 1 ? emojis.reply : emojis.stem, line))
    .join('\n')
    .slice(0, DESCRIPTION_MAX);
}

export function logEmbed(input: LogEmbedInput): Record<string, unknown> {
  // No markdown in the title: Discord renders embed titles as plain text, already bold, so
  // literal asterisks would show up as asterisks.
  const title = `${input.subject} ${input.action}`.slice(0, TITLE_MAX);

  return {
    title,
    color: input.colour,
    description: logBody(input.lines, input.emojis),
    ...(input.fields?.length
      ? {
          fields: input.fields.map((field) => ({
            name: field.name.slice(0, FIELD_NAME_MAX),
            value: field.value.slice(0, FIELD_VALUE_MAX),
          })),
        }
      : {}),
    footer: {
      text: (input.executor?.username ?? 'Unknown').slice(0, FOOTER_MAX),
      ...(input.executor?.avatarUrl ? { icon_url: input.executor.avatarUrl } : {}),
    },
    timestamp: new Date(input.occurredAt).toISOString(),
  };
}

const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(value: string | undefined): boolean {
  return value !== undefined && SNOWFLAKE.test(value);
}

/**
 * Discord only resolves a mention whose id is a snowflake; anything else renders as the literal
 * `<@…>` text. Not every id reaching a log is one — a dashboard actor is a Better Auth id, a
 * module actor is `proton:…` — so mentions are built here rather than interpolated at call sites.
 */
export function userMention(userId: string | undefined): string | undefined {
  return isSnowflake(userId) ? `<@${userId}>` : undefined;
}

export function channelMention(channelId: string | undefined): string | undefined {
  return isSnowflake(channelId) ? `<#${channelId}>` : undefined;
}

export function roleMention(roleId: string | undefined): string | undefined {
  return isSnowflake(roleId) ? `<@&${roleId}>` : undefined;
}

export function jumpUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function timestampLine(seconds: number): string {
  return `<t:${Math.floor(seconds)}:R>`;
}
