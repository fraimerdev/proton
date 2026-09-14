import {
  type ContainerChild,
  type MessageButton,
  parseComponentEmoji,
  type V2Component,
} from '@proton/core';
import type { TicketPanel, TicketType } from '@proton/module-tickets/config';
import { TICKET_ACCENT } from './shape.ts';

export const BUTTONS_SHOWN_MAX = 15;
export const SELECT_OPTIONS_MAX = 25;
export const DEFAULT_SELECT_PLACEHOLDER = 'Choose what you need help with…';

export function noTypesReason(panel: TicketPanel): string {
  return (
    `The **${panel.name}** panel has no ticket types on it, so its buttons would open nothing. ` +
    'Add at least one under Tickets → Ticket types, then attach it to the panel.'
  );
}

export function shownOnPanel(panel: TicketPanel, types: readonly TicketType[]): TicketType[] {
  return panel.style === 'select'
    ? types.slice(0, SELECT_OPTIONS_MAX)
    : types.slice(0, BUTTONS_SHOWN_MAX);
}

export function panelPreview(panel: TicketPanel, types: readonly TicketType[]): V2Component[] {
  const children: ContainerChild[] = [];

  if (panel.authorName) children.push({ kind: 'text', content: `-# ${panel.authorName}` });

  children.push({ kind: 'text', content: `## ${panel.title ?? panel.name}` });

  if (panel.thumbnailUrl) {
    children.push({
      kind: 'section',
      text: [panel.panelText],
      accessory: { kind: 'thumbnail', url: panel.thumbnailUrl },
    });
  } else {
    children.push({ kind: 'text', content: panel.panelText });
  }

  if (panel.imageUrl) {
    children.push({ kind: 'gallery', items: [{ url: panel.imageUrl }] });
  }

  children.push({ kind: 'separator', divider: false, spacing: 'small' });

  if (panel.style === 'select') {
    children.push({
      kind: 'row',
      row: {
        kind: 'select',
        select: {
          key: 'os',
          placeholder: panel.selectPlaceholder ?? DEFAULT_SELECT_PLACEHOLDER,
          // Empty on purpose: a collapsed select shows only its placeholder.
          options: [],
        },
      },
    });
  } else {
    const shown = shownOnPanel(panel, types);

    for (let index = 0; index < shown.length; index += 5) {
      const buttons: MessageButton[] = shown.slice(index, index + 5).map((type, position) => {
        const emoji = parseComponentEmoji(type.emoji);

        return {
          key: `t${index + position}`,
          style: 'primary',
          label: type.name.slice(0, 80),
          ...(emoji ? { emoji } : {}),
        };
      });

      if (buttons.length > 0) children.push({ kind: 'row', row: { kind: 'buttons', buttons } });
    }
  }

  if (panel.footerText) {
    children.push(
      { kind: 'separator', divider: true, spacing: 'small' },
      { kind: 'text', content: `-# ${panel.footerText}` },
    );
  }

  return [{ kind: 'container', accentColor: panel.colour ?? TICKET_ACCENT, children }];
}
