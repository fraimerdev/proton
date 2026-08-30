import { encodeCustomId } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import type { AppealPanel } from './config.ts';
import { MODULE_ID } from './config.ts';
import type { AppealRecord } from './store.ts';

export const APPROVE_ACTION = 'approve';
export const DENY_ACTION = 'deny';

// DESIGN.md: amber is advisory — something is waiting on a person. Green and coral are what the
// card becomes once somebody has decided.
export const APPEAL_OPEN = 0xf0b752;
export const APPEAL_APPROVED = 0x4fcf95;
export const APPEAL_DENIED = 0xff7a86;

const ANSWER_MAX_SHOWN = 900;

export type ReviewCard =
  | { ok: true; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

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

// Fenced and de-backticked. An appellant is an unaffiliated stranger writing prose that a
// moderator reads: without this they choose the markdown on somebody else's screen.
function quoted(value: string): string {
  const cut = value.length > ANSWER_MAX_SHOWN ? `${value.slice(0, ANSWER_MAX_SHOWN)}…` : value;

  return ['```', cut.replaceAll('`', "'"), '```'].join('\n');
}

function accentFor(appeal: AppealRecord): number {
  if (appeal.status === 'approved') return APPEAL_APPROVED;
  if (appeal.status === 'denied') return APPEAL_DENIED;

  return APPEAL_OPEN;
}

function heading(appeal: AppealRecord, panel: AppealPanel): string {
  const verdict =
    appeal.status === 'approved'
      ? ' — accepted'
      : appeal.status === 'denied'
        ? ' — turned down'
        : '';

  return `## Appeal #${appeal.number}${verdict}\n**${panel.name}** · <@${appeal.userId}>`;
}

export function buildReviewCard(appeal: AppealRecord, panel: AppealPanel): ReviewCard {
  const body: Record<string, unknown>[] = [text(heading(appeal, panel))];

  for (const answer of appeal.answers) {
    body.push(text(`**${answer.label}**\n${quoted(answer.value)}`));
  }

  if (appeal.status === 'open') {
    const approve = encodeCustomId(MODULE_ID, APPROVE_ACTION, appeal.id);
    const deny = encodeCustomId(MODULE_ID, DENY_ACTION, appeal.id);

    if (!approve.ok) return { ok: false, humanReason: approve.humanReason };
    if (!deny.ok) return { ok: false, humanReason: deny.humanReason };

    body.push(separator(), {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: 'Accept',
          custom_id: approve.customId,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          label: 'Turn down',
          custom_id: deny.customId,
        },
      ],
    });

    return { ok: true, components: [container(accentFor(appeal), ...body)] };
  }

  body.push(
    separator(),
    text(
      `${appeal.status === 'approved' ? 'Accepted' : 'Turned down'} by <@${appeal.decidedBy}>` +
        (appeal.outcomeApplied ? '.' : ' — the outcome has NOT been carried out yet.'),
    ),
  );

  return { ok: true, components: [container(accentFor(appeal), ...body)] };
}
