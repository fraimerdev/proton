import { encodeCustomId, type TicketPriority } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import {
  MODULE_ID,
  PRIORITY_LABELS,
  renderOpeningMessage,
  type TicketPanel,
  type TicketType,
} from './config.ts';
import type { Ticket, TicketFormAnswer, TicketParticipant } from './store.ts';

export const OPEN_ACTION = 'open';
export const OPEN_TYPE_ACTION = 'ot';
export const SELECT_TYPE_ACTION = 'os';
export const FORM_ACTION = 'form';

export const CLOSE_ACTION = 'close';
export const CLOSE_REASON_ACTION = 'closem';
export const CLOSE_CONFIRM_ACTION = 'closeok';
export const CLOSE_CANCEL_ACTION = 'closeno';
export const CLAIM_ACTION = 'claim';
export const UNCLAIM_ACTION = 'unclaim';
export const ADD_ACTION = 'add';
export const REMOVE_ACTION = 'remove';
export const LOCK_ACTION = 'lock';
export const UNLOCK_ACTION = 'unlock';
export const PRIORITY_ACTION = 'prio';
export const ASSIGN_ACTION = 'assign';
export const MOVE_ACTION = 'move';
export const REOPEN_ACTION = 'reopen';
export const DELETE_ACTION = 'del';
export const DELETE_CONFIRM_ACTION = 'delok';
export const TRANSCRIPT_ACTION = 'script';
export const INFO_ACTION = 'info';
export const OPTIONS_ACTION = 'opts';
export const RATE_ACTION = 'rate';

export const TICKET_ACCENT = 0x3874f3;
export const TICKET_CLOSED_ACCENT = 0x868e9f;

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

function row(...components: Record<string, unknown>[]): Record<string, unknown> {
  return { type: ComponentType.ActionRow, components };
}

const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;

export function toEmoji(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  const custom = CUSTOM_EMOJI.exec(raw);
  if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === 'a' };

  return { name: raw };
}

function button(
  style: ButtonStyle,
  label: string,
  customId: string,
  emoji?: string,
): Record<string, unknown> {
  const parsed = toEmoji(emoji);

  return {
    type: ComponentType.Button,
    style,
    label,
    custom_id: customId,
    ...(parsed ? { emoji: parsed } : {}),
  };
}

export type BuildResult<T> = { ok: true; value: T } | { ok: false; humanReason: string };

function id(action: string, ...args: string[]): BuildResult<string> {
  const encoded = encodeCustomId(MODULE_ID, action, ...args);

  return encoded.ok
    ? { ok: true, value: encoded.customId }
    : { ok: false, humanReason: encoded.humanReason };
}

export interface PanelMessage {
  components: Record<string, unknown>[];
}

export function buildPanelComponents(
  panel: TicketPanel,
  types: readonly TicketType[],
): BuildResult<PanelMessage> {
  if (types.length === 0) {
    return {
      ok: false,
      humanReason:
        `The **${panel.name}** panel has no ticket types on it, so its buttons would open ` +
        'nothing. Add at least one under Tickets → Ticket types, then attach it to the panel.',
    };
  }

  const body: Record<string, unknown>[] = [];

  if (panel.authorName) body.push(text(`-# ${panel.authorName}`));

  body.push(text(`## ${panel.title ?? panel.name}`), text(panel.panelText));

  const heading = panel.thumbnailUrl
    ? {
        type: ComponentType.Section,
        components: body.slice(-1),
        accessory: { type: ComponentType.Thumbnail, media: { url: panel.thumbnailUrl } },
      }
    : null;

  const composed = heading ? [...body.slice(0, -1), heading] : body;

  if (panel.imageUrl) {
    composed.push({
      type: ComponentType.MediaGallery,
      items: [{ media: { url: panel.imageUrl } }],
    });
  }

  composed.push(spacer());

  if (panel.style === 'select') {
    const customId = id(SELECT_TYPE_ACTION, panel.id);
    if (!customId.ok) return customId;

    composed.push(
      row({
        type: ComponentType.StringSelect,
        custom_id: customId.value,
        placeholder: panel.selectPlaceholder ?? 'Choose what you need help with…',
        options: types.slice(0, 25).map((type) => ({
          label: type.name.slice(0, 100),
          value: type.id,
          ...(type.description ? { description: type.description.slice(0, 100) } : {}),
          ...(toEmoji(type.emoji) ? { emoji: toEmoji(type.emoji) } : {}),
        })),
      }),
    );
  } else {
    // Five to a row and Discord takes five rows, but a panel is not a keyboard: past fifteen the
    // select style is the only one that stays readable, so the rest are dropped rather than hidden
    // behind a wall of buttons.
    const shown = types.slice(0, 15);

    for (let index = 0; index < shown.length; index += 5) {
      const buttons: Record<string, unknown>[] = [];

      for (const type of shown.slice(index, index + 5)) {
        const customId = id(OPEN_TYPE_ACTION, panel.id, type.id);
        if (!customId.ok) return customId;

        buttons.push(
          button(ButtonStyle.Primary, type.name.slice(0, 80), customId.value, type.emoji),
        );
      }

      composed.push(row(...buttons));
    }
  }

  if (panel.footerText) composed.push(separator(), text(`-# ${panel.footerText}`));

  return {
    ok: true,
    value: { components: [container(panel.colour ?? TICKET_ACCENT, ...composed)] },
  };
}

export interface TicketView {
  ticket: Ticket;
  type: TicketType | undefined;
  typeName: string;
  staffRoleIds: readonly string[];
  answers: readonly TicketFormAnswer[];
  participants: readonly TicketParticipant[];
}

export function describeStatus(ticket: Ticket): string {
  if (ticket.status === 'deleted') return 'Deleted';
  if (ticket.status === 'archived') return 'Archived';
  if (ticket.status === 'closed') return 'Closed';
  if (ticket.lockedAt) return 'Open · Locked';
  if (ticket.closeRequestedAt) return 'Open · Close requested';
  if (ticket.waitingOn === 'staff') return 'Open · Waiting on staff';
  if (ticket.waitingOn === 'user') return 'Open · Waiting on the member';

  return 'Open';
}

export function describePriority(priority: TicketPriority): string {
  return PRIORITY_LABELS[priority];
}

function stamp(date: Date | null | undefined, style = 'f'): string {
  return date ? `<t:${Math.floor(date.getTime() / 1000)}:${style}>` : '—';
}

export function buildControlRows(view: TicketView): BuildResult<Record<string, unknown>[]> {
  const { ticket, type } = view;
  const rows: Record<string, unknown>[] = [];

  if (ticket.status === 'closed' || ticket.status === 'archived') {
    const reopen = id(REOPEN_ACTION);
    const remove = id(DELETE_ACTION);
    const transcript = id(TRANSCRIPT_ACTION);
    if (!reopen.ok) return reopen;
    if (!remove.ok) return remove;
    if (!transcript.ok) return transcript;

    const closed: Record<string, unknown>[] = [];

    if (type?.reopenEnabled !== false) {
      closed.push(button(ButtonStyle.Success, 'Reopen', reopen.value));
    }

    closed.push(
      button(ButtonStyle.Secondary, 'Transcript', transcript.value),
      button(ButtonStyle.Danger, 'Delete', remove.value),
    );

    return { ok: true, value: [row(...closed)] };
  }

  const close = id(CLOSE_ACTION);
  const claim = id(ticket.claimedById === null ? CLAIM_ACTION : UNCLAIM_ACTION);
  const add = id(ADD_ACTION);
  const options = id(OPTIONS_ACTION);
  if (!close.ok) return close;
  if (!claim.ok) return claim;
  if (!add.ok) return add;
  if (!options.ok) return options;

  const primary: Record<string, unknown>[] = [button(ButtonStyle.Danger, 'Close', close.value)];

  if ((type?.claimMode ?? 'single') !== 'off') {
    primary.push(
      ticket.claimedById === null
        ? button(ButtonStyle.Success, 'Claim', claim.value)
        : button(ButtonStyle.Secondary, 'Unclaim', claim.value),
    );
  }

  primary.push(
    button(ButtonStyle.Secondary, 'Add user', add.value),
    button(ButtonStyle.Secondary, 'Options', options.value),
  );

  rows.push(row(...primary));

  return { ok: true, value: rows };
}

export function buildOptionRows(view: TicketView): BuildResult<Record<string, unknown>[]> {
  const locked = view.ticket.lockedAt !== null;

  const lock = id(locked ? UNLOCK_ACTION : LOCK_ACTION);
  const rename = id('rename');
  const remove = id(REMOVE_ACTION);
  const info = id(INFO_ACTION);
  const transcript = id(TRANSCRIPT_ACTION);
  const priority = id(PRIORITY_ACTION);
  const assign = id(ASSIGN_ACTION);
  const relocate = id(MOVE_ACTION);
  if (!lock.ok) return lock;
  if (!rename.ok) return rename;
  if (!remove.ok) return remove;
  if (!info.ok) return info;
  if (!transcript.ok) return transcript;
  if (!priority.ok) return priority;
  if (!assign.ok) return assign;
  if (!relocate.ok) return relocate;

  return {
    ok: true,
    value: [
      row({
        type: ComponentType.StringSelect,
        custom_id: priority.value,
        placeholder: 'Set priority…',
        options: (['low', 'medium', 'high', 'urgent'] as const).map((level) => ({
          label: PRIORITY_LABELS[level],
          value: level,
          default: view.ticket.priority === level,
        })),
      }),
      row(
        locked
          ? button(ButtonStyle.Success, 'Unlock', lock.value)
          : button(ButtonStyle.Secondary, 'Lock', lock.value),
        button(ButtonStyle.Secondary, 'Remove user', remove.value),
        button(ButtonStyle.Secondary, 'Rename', rename.value),
        button(ButtonStyle.Secondary, 'Info', info.value),
        button(ButtonStyle.Secondary, 'Transcript', transcript.value),
      ),
      row(
        button(ButtonStyle.Secondary, 'Assign', assign.value),
        button(ButtonStyle.Secondary, 'Move', relocate.value),
      ),
    ],
  };
}

export function buildWelcomeComponents(
  view: TicketView,
  welcomeTemplate: string,
): BuildResult<Record<string, unknown>[]> {
  const { ticket } = view;

  const controls = buildControlRows(view);
  if (!controls.ok) return controls;

  const staff = view.staffRoleIds.map((roleId) => `<@&${roleId}>`).join(' ');

  const body: Record<string, unknown>[] = [
    text(`## Ticket #${ticket.number}`),
    text(renderOpeningMessage(welcomeTemplate, ticket.ownerId)),
    separator(),
    text(
      `**Type**\n${view.typeName}\n\n**Priority**\n${describePriority(ticket.priority)}` +
        (staff ? `\n\n**Who can see this**\nYou and ${staff}` : ''),
    ),
  ];

  if (view.answers.length > 0) {
    body.push(
      separator(),
      text(
        view.answers
          .map((answer) => `**${answer.label}**\n${answer.value.slice(0, 900)}`)
          .join('\n\n')
          .slice(0, 3900),
      ),
    );
  }

  body.push(spacer(), ...controls.value);

  return { ok: true, value: [container(TICKET_ACCENT, ...body)] };
}

export function buildInfoComponents(
  view: TicketView,
  extra: { messageCount: number; rating: number | null },
): Record<string, unknown>[] {
  const { ticket } = view;

  const lines = [
    `**Type**\n${view.typeName}`,
    `**Status**\n${describeStatus(ticket)}`,
    `**Priority**\n${describePriority(ticket.priority)}`,
    `**Raised by**\n<@${ticket.openerId}>`,
    ...(ticket.ownerId === ticket.openerId ? [] : [`**Owner**\n<@${ticket.ownerId}>`]),
    `**Opened**\n${stamp(ticket.openedAt)}`,
    `**Claimed by**\n${ticket.claimedById ? `<@${ticket.claimedById}>` : 'Nobody yet'}`,
    ...(ticket.assignedToId ? [`**Assigned to**\n<@${ticket.assignedToId}>`] : []),
    `**Participants**\n${view.participants.length}`,
    `**Messages**\n${extra.messageCount}`,
    `**Last activity**\n${stamp(ticket.lastActivityAt, 'R')}`,
    ...(ticket.firstResponseAt ? [`**First reply**\n${stamp(ticket.firstResponseAt, 'R')}`] : []),
    ...(ticket.closedAt ? [`**Closed**\n${stamp(ticket.closedAt)} by <@${ticket.closedBy}>`] : []),
    ...(ticket.closeReason ? [`**Reason**\n${ticket.closeReason}`] : []),
    ...(extra.rating === null ? [] : [`**Rating**\n${extra.rating} out of 5`]),
  ];

  return [
    container(
      ticket.status === 'open' ? TICKET_ACCENT : TICKET_CLOSED_ACCENT,
      text(`## Ticket #${ticket.number}`),
      ...(ticket.subject ? [text(ticket.subject)] : []),
      separator(),
      text(lines.join('\n\n')),
    ),
  ];
}

export function buildCloseRequestComponents(
  ticket: Ticket,
  byId: string,
  reason: string | null,
): BuildResult<Record<string, unknown>[]> {
  const confirm = id(CLOSE_CONFIRM_ACTION);
  const cancel = id(CLOSE_CANCEL_ACTION);
  if (!confirm.ok) return confirm;
  if (!cancel.ok) return cancel;

  return {
    ok: true,
    value: [
      container(
        0xf0b752,
        text(`### Is ticket #${ticket.number} sorted?`),
        text(
          `<@${byId}> would like to close this ticket.` +
            (reason ? `\n\n**Reason**\n${reason}` : '') +
            `\n\n<@${ticket.ownerId}>, confirm below if your problem is solved, or say it is not ` +
            'and the ticket stays open.',
        ),
        spacer(),
        row(
          button(ButtonStyle.Success, 'Yes, close it', confirm.value),
          button(ButtonStyle.Secondary, 'Keep it open', cancel.value),
        ),
      ),
    ],
  };
}

export function buildRatingComponents(ticket: Ticket): BuildResult<Record<string, unknown>[]> {
  const buttons: Record<string, unknown>[] = [];

  for (const score of [1, 2, 3, 4, 5]) {
    const customId = id(RATE_ACTION, ticket.id, String(score));
    if (!customId.ok) return customId;

    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: String(score),
      custom_id: customId.value,
    });
  }

  return {
    ok: true,
    value: [
      container(
        TICKET_ACCENT,
        text('### How was your support experience?'),
        // The buttons used to be rows of stars, which said "1 is bad, 5 is good" without a word.
        // Numbers do not, so the scale has to be spelled out.
        text(
          `Ticket #${ticket.number} is closed. If you have a moment, rate the help you got from ` +
            '**1** (poor) to **5** (excellent) — it is only visible to the staff team.',
        ),
        spacer(),
        row(...buttons),
      ),
    ],
  };
}
