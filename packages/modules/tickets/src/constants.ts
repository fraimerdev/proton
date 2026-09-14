import type { TicketPriority } from '@proton/core';

export const NUMBER_PLACEHOLDER = '{number}';
export const USER_PLACEHOLDER = '{user}';
export const TYPE_PLACEHOLDER = '{type}';

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
