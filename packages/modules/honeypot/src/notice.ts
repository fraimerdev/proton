import {
  type EntitlementTier,
  encodeCustomId,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type ProtonMessage,
  substitute,
  toDiscordMessage,
  type V2Component,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import {
  DEFAULT_DM_MESSAGE,
  DEFAULT_NOTICE_MESSAGE,
  describeWindow,
  HONEYPOT_COLOUR,
  type HoneypotAction,
  type HoneypotConfig,
  MODULE_ID,
} from './config.ts';
import { COUNTER_KEY, HONEYPOT_POT, QUIET_NOTICE_BODY, RECOVERY_ADVICE } from './layout.ts';

export const STATS_ACTION = 'stats';

export const RECOVERY_ADVICE_TEXT = RECOVERY_ADVICE;

export { HONEYPOT_COLOUR, HONEYPOT_POT };

// The button never says "Kicks" over a trap that softbans, so the noun is read from the action.
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

export const DM_ACTION_WORD: Record<HoneypotAction, string> = {
  softban: 'removed from the server, and can rejoin straight away',
  ban: 'banned',
  kick: 'removed from the server',
  timeout: 'timed out',
  warn: 'given a warning',
  none: 'reported to the moderators',
};

export function caughtLabel(action: HoneypotAction, caught: number): string {
  return `${CAUGHT_NOUN[action]}: ${caught}`;
}

export function consequenceOf(action: HoneypotAction): string {
  return CONSEQUENCE[action];
}

export function purgeSentence(config: HoneypotConfig): string {
  const purges = config.action === 'softban' || config.action === 'ban';

  return purges && config.deleteMessageSeconds > 0
    ? ` Everything you posted in ${describeWindow(config.deleteMessageSeconds)} is deleted with you.`
    : '';
}

export type LayoutSlot = 'noticeLayout' | 'dmLayout';

const BUILT_IN: Record<LayoutSlot, ProtonMessage> = {
  noticeLayout: DEFAULT_NOTICE_MESSAGE as ProtonMessage,
  dmLayout: DEFAULT_DM_MESSAGE as ProtonMessage,
};

/**
 * Render-only, and never on the write path. A free guild's own layout stays in `guild_modules`
 * untouched — substituting here rather than at save time is what stops one unrelated toggle from
 * overwriting work an admin did while they were on a paid tier.
 */
export function layoutFor(
  config: HoneypotConfig,
  slot: LayoutSlot,
  tier: EntitlementTier | undefined,
): ProtonMessage {
  return (tier ?? 'free') === 'free' ? BUILT_IN[slot] : (config[slot] as ProtonMessage);
}

// Appended, not stored. The counter is Proton's own button — a stored non-link button has to
// carry a ComponentAction, and there is no action in that vocabulary for "open this trap's tally".
export function appendRow(v2: readonly V2Component[], row: V2Component): V2Component[] {
  const last = v2.findLastIndex((component) => component.kind === 'container');
  if (last === -1) return [...v2, row];

  return v2.map((component, index) => {
    if (index !== last || component.kind !== 'container') return component;

    return { ...component, children: [...component.children, row as never] };
  });
}

export type NoticeResult =
  | { ok: true; components: Record<string, unknown>[]; flags: number }
  | { ok: false; humanReason: string };

export function buildNoticeComponents(
  config: HoneypotConfig,
  channelId: string,
  caught: number,
  tier: EntitlementTier | undefined,
): NoticeResult {
  const customId = encodeCustomId(MODULE_ID, STATS_ACTION, channelId);
  if (!customId.ok) return { ok: false, humanReason: customId.humanReason };

  const layout = layoutFor(config, 'noticeLayout', tier);

  const body = config.hideWhatIsAHoneypot
    ? (substitute(QUIET_NOTICE_BODY, {
        consequence: CONSEQUENCE[config.action],
        purge: purgeSentence(config),
      }) as string)
    : undefined;

  const substituted = substitute(layout, {
    consequence: CONSEQUENCE[config.action],
    purge: purgeSentence(config),
  }) as ProtonMessage;

  const withBody = body ? replaceBody(substituted.v2, body) : substituted.v2;

  const v2 = config.noticeCounterButton
    ? appendRow(withBody, {
        kind: 'row',
        row: {
          kind: 'buttons',
          buttons: [
            {
              key: COUNTER_KEY,
              style: 'secondary',
              label: caughtLabel(config.action, caught),
              emoji: { name: HONEYPOT_POT },
            },
          ],
        },
      })
    : withBody;

  const rendered = toDiscordMessage(
    { ...substituted, v2 },
    {
      customIdFor: () => customId.customId,
    },
  );

  return {
    ok: true,
    components: (rendered.components ?? []) as unknown as Record<string, unknown>[],
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
  };
}

// The second text display of the first container is the body the default layout ships. An admin
// who authored their own said what they wanted said, so nothing is swapped there.
function replaceBody(v2: readonly V2Component[], body: string): V2Component[] {
  let replaced = false;

  return v2.map((component) => {
    if (component.kind !== 'container' || replaced) return component;

    let seen = 0;
    const children = component.children.map((child) => {
      if (child.kind !== 'text') return child;

      seen += 1;
      if (seen !== 2) return child;

      replaced = true;
      return { ...child, content: body };
    });

    return { ...component, children };
  });
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

function text(content: string): Record<string, unknown> {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): Record<string, unknown> {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function container(
  accent: number,
  ...components: Record<string, unknown>[]
): Record<string, unknown> {
  return { type: ComponentType.Container, accent_color: accent, components };
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
