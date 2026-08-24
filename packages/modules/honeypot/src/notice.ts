import { encodeCustomId } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { describeWindow, type HoneypotAction, type HoneypotChannel, MODULE_ID } from './config.ts';

export const STATS_ACTION = 'stats';

// DESIGN.md's Blocked Coral: "something cannot run, or the user is about to destroy something".
export const HONEYPOT_COLOUR = 0xff7a86;

export const HONEYPOT_POT = '🍯';

// The button never says "Kicks" over a trap that softbans, so the noun is read per channel.
const CAUGHT_NOUN: Record<HoneypotAction, string> = {
  softban: 'Softbans',
  ban: 'Bans',
  kick: 'Kicks',
  timeout: 'Timeouts',
  warn: 'Warnings',
  none: 'Caught',
};

const CONSEQUENCE: Record<HoneypotAction, string> = {
  softban: 'you are removed from the server and let straight back in',
  ban: 'you are banned from the server',
  kick: 'you are removed from the server',
  timeout: 'you are timed out and cannot speak',
  warn: 'it is recorded against your account',
  none: 'it is reported to the moderators',
};

export function caughtLabel(action: HoneypotAction, caught: number): string {
  return `${CAUGHT_NOUN[action]}: ${caught}`;
}

function text(content: string): Record<string, unknown> {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): Record<string, unknown> {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function spacer(): Record<string, unknown> {
  return { type: ComponentType.Separator, divider: false, spacing: 1 };
}

function container(
  accent: number,
  ...components: Record<string, unknown>[]
): Record<string, unknown> {
  return { type: ComponentType.Container, accent_color: accent, components };
}

export type NoticeResult =
  | { ok: true; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

export function buildNoticeComponents(channel: HoneypotChannel, caught: number): NoticeResult {
  const customId = encodeCustomId(MODULE_ID, STATS_ACTION, channel.channelId);
  if (!customId.ok) return { ok: false, humanReason: customId.humanReason };

  const purge =
    (channel.action === 'softban' || channel.action === 'ban') && channel.deleteMessageSeconds > 0
      ? ` Everything you posted in ${describeWindow(channel.deleteMessageSeconds)} is deleted with you.`
      : '';

  return {
    ok: true,
    components: [
      container(
        HONEYPOT_COLOUR,
        text(`## ${HONEYPOT_POT}  DO NOT SEND MESSAGES IN THIS CHANNEL`),
        text(
          'This channel is used to catch spam bots and compromised accounts, which post in every ' +
            `channel they can see. Any message sent here means **${CONSEQUENCE[channel.action]}**.` +
            `${purge}\n\nThere is never a reason to post here.`,
        ),
        spacer(),
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: caughtLabel(channel.action, caught),
              emoji: { name: HONEYPOT_POT },
              custom_id: customId.customId,
            },
          ],
        },
      ),
    ],
  };
}

export interface StatsView {
  channelId: string;
  action: HoneypotAction;

  total: number;
  lastDay: number;
  lastWeek: number;

  byAction: Record<string, number>;
  recent: ReadonlyArray<{ userId: string; action: string; at: number }>;

  privileged: boolean;
}

function plural(count: number, one: string, many: string): string {
  return `**${count}** ${count === 1 ? one : many}`;
}

export function buildStatsComponents(view: StatsView): Record<string, unknown>[] {
  const body: Record<string, unknown>[] = [text(`## ${HONEYPOT_POT}  <#${view.channelId}>`)];

  if (view.total === 0) {
    body.push(
      text('Nothing has walked into this trap yet. That is the outcome to hope for.'),
      separator(),
      text('It is armed and watching. Every message posted here trips it.'),
    );

    return [container(HONEYPOT_COLOUR, ...body)];
  }

  body.push(
    text(
      `${plural(view.total, 'member caught', 'members caught')} since this trap was armed.\n` +
        `**${view.lastDay}** in the last 24 hours · **${view.lastWeek}** in the last 7 days.`,
    ),
  );

  const breakdown = Object.entries(view.byAction)
    .filter(([, count]) => count > 0)
    .map(([action, count]) => `${CAUGHT_NOUN[action as HoneypotAction] ?? action} ×${count}`)
    .join(' · ');

  if (breakdown) body.push(separator(), text(`**What happened to them**\n${breakdown}`));

  if (!view.privileged) {
    body.push(separator(), text('Only moderators can see which accounts were caught.'));

    return [container(HONEYPOT_COLOUR, ...body)];
  }

  const lines = view.recent
    .map((entry) => `<@${entry.userId}> · <t:${Math.floor(entry.at / 1000)}:R>`)
    .join('\n');

  // A trap can have a lifetime total and an empty list, because the list is trimmed at 30 days and
  // the total is not. Saying nothing there reads as the permission check having failed.
  body.push(
    separator(),
    text(
      lines
        ? `**Most recent**\n${lines}`
        : 'Nobody in the last 30 days — that is as far back as the member list is kept.',
    ),
  );

  return [container(HONEYPOT_COLOUR, ...body)];
}
