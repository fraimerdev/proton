import { type ActionFailure, MESSAGE_CONTENT_MAX, NICKNAME_MAX } from '@proton/core';
import { RECAP_MAX } from './config.ts';
import type { AfkPing } from './store.ts';

export const AFK_TAG = '[AFK]';

export const NOTICE_LINES_MAX = 5;

export type RecapOutcome = 'sent' | 'undeliverable' | 'none';

export interface NoticeEntry {
  name: string;
  reason: string | null;
  since: Date;
}

export function unixSeconds(date: Date | number): number {
  return Math.floor((typeof date === 'number' ? date : date.getTime()) / 1000);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clip(text: string, max: number): string {
  let out = '';
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

export function isTagged(name: string): boolean {
  return name.startsWith(AFK_TAG);
}

export function tagNickname(base: string): string {
  if (isTagged(base)) return base;
  return clip(`${AFK_TAG} ${base}`, NICKNAME_MAX).trimEnd();
}

export function untagged(name: string): string {
  if (!isTagged(name)) return name;
  const rest = name.slice(AFK_TAG.length).trim();
  return rest.length > 0 ? rest : name;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|<>[\]:]/g, (character) => `\\${character}`);
}

export function displayName(...candidates: ReadonlyArray<string | null | undefined>): string {
  const chosen = candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
  );
  return escapeMarkdown(untagged(chosen ?? 'Someone'));
}

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;

  if (days > 0) {
    return hours > 0 ? `${plural(days, 'day')} and ${plural(hours, 'hour')}` : plural(days, 'day');
  }

  if (hours > 0) {
    return rest > 0
      ? `${plural(hours, 'hour')} and ${plural(rest, 'minute')}`
      : plural(hours, 'hour');
  }

  return plural(rest, 'minute');
}

export function renderNotice(entries: readonly NoticeEntry[]): string {
  const lines = entries.slice(0, NOTICE_LINES_MAX).map((entry) => {
    const since = `<t:${unixSeconds(entry.since)}:R>`;
    return entry.reason
      ? `**${entry.name}** is AFK: ${escapeMarkdown(entry.reason)} · ${since}`
      : `**${entry.name}** is AFK · ${since}`;
  });

  const hidden = entries.length - lines.length;
  if (hidden > 0) lines.push(`…and ${hidden} more.`);

  return lines.join('\n').slice(0, MESSAGE_CONTENT_MAX);
}

export function renderRecapNote(recap: RecapOutcome, pingCount: number): string | null {
  const capped = pingCount >= RECAP_MAX;

  if (recap === 'sent') {
    return capped
      ? `I've sent you the latest ${RECAP_MAX} pings you missed.`
      : `I've sent you the ${plural(pingCount, 'ping')} you missed.`;
  }

  if (recap === 'undeliverable') {
    const count = capped ? `At least ${RECAP_MAX} pings` : plural(pingCount, 'ping');
    return `${count} came in while you were away, but I couldn't DM you the list.`;
  }

  return null;
}

export function renderWelcome(
  name: string,
  elapsedMs: number,
  recap: RecapOutcome,
  pingCount: number,
  untagProblem: string | null = null,
): string {
  const parts = [`Welcome back, **${name}**. You were AFK for ${formatElapsed(elapsedMs)}.`];

  const note = renderRecapNote(recap, pingCount);
  if (note) parts.push(note);
  if (untagProblem) parts.push(`I couldn't take [AFK] off your nickname: ${untagProblem}`);

  return parts.join(' ').slice(0, MESSAGE_CONTENT_MAX);
}

export function renderRecap(guildId: string, pings: readonly AfkPing[]): string[] {
  const header =
    pings.length >= RECAP_MAX
      ? `Here are the ${RECAP_MAX} most recent pings from while you were AFK:`
      : `You were pinged ${plural(pings.length, 'time')} while you were AFK:`;

  const chunks: string[] = [];
  let current = header;

  for (const ping of pings) {
    const line =
      `<@${ping.authorId}> in <#${ping.channelId}> <t:${unixSeconds(ping.pingedAt)}:R> — ` +
      `https://discord.com/channels/${guildId}/${ping.channelId}/${ping.messageId}`;

    if (current.length + 1 + line.length > MESSAGE_CONTENT_MAX) {
      chunks.push(current);
      current = line;
    } else {
      current = `${current}\n${line}`;
    }
  }

  chunks.push(current);
  return chunks;
}

export type Whose = 'your' | 'their';

export function nicknameProblem(failure: ActionFailure, whose: Whose): string {
  switch (failure.code) {
    case 'target_is_owner':
      return "Discord doesn't let bots change the server owner's nickname.";
    case 'role_hierarchy':
      return (
        `${whose} highest role is at or above mine. Move Proton's role higher in Server ` +
        'Settings → Roles.'
      );
    case 'missing_permission':
      return "I'm missing the Manage Nicknames permission in this server.";
    default:
      return failure.humanReason;
  }
}
