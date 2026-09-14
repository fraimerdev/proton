import {
  type DisplayNameStyle,
  NAME_STYLE_EFFECT_LABELS,
  NAME_STYLE_FONT_LABELS,
  sameDisplayNameStyle,
} from '@proton/module-branding/name-style';
import { fromWireStyle, type NameStyleStatus } from '@proton/module-branding/name-style-status';
import type { ReactElement } from 'react';
import { Spinner } from '../../../components/ui/feedback.tsx';
import type { ProtonAccount } from '../../../lib/discord.ts';
import { issueAt } from './shape.ts';

export const NAME_STYLE_POLL_WINDOW_MS = 120_000;

export const NAME_STYLE_STATUS_TEXT = {
  checking: 'Checking with Discord',
  unreadable: 'Couldn’t check the style’s status.',
  unsaved: 'Save to apply in Discord',
  applied: 'Applied in Discord',
  applying: 'Applying…',
  refused: 'Discord didn’t accept this style',
  permission: 'Proton needs Change Nickname in this server',
  unconfirmed: 'Couldn’t confirm with Discord',
  off: 'Applies when Branding is switched on',
} as const;

export type NameStyleStatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface NameStyleStatusCopy {
  text: string;
  tone: NameStyleStatusTone;
  busy: boolean;
}

function line(text: string, tone: NameStyleStatusTone, busy = false): NameStyleStatusCopy {
  return { text, tone, busy };
}

function unavailableText(style: DisplayNameStyle | null): string {
  return (
    issueAt(style, 'displayNameStyle.font') ??
    issueAt(style, 'displayNameStyle.effect') ??
    issueAt(style, 'displayNameStyle.colours') ??
    NAME_STYLE_STATUS_TEXT.refused
  );
}

export function nameStyleStatusCopy({
  status,
  failed,
  saved,
  draft,
  pollingOver,
}: {
  status: NameStyleStatus | undefined;
  failed: boolean;
  saved: DisplayNameStyle | null;
  draft: DisplayNameStyle | null;
  pollingOver: boolean;
}): NameStyleStatusCopy | null {
  const { checking, unreadable } = NAME_STYLE_STATUS_TEXT;

  if (!sameDisplayNameStyle(draft, saved)) return line(NAME_STYLE_STATUS_TEXT.unsaved, 'neutral');

  // An answer about an earlier save would name the wrong style's outcome.
  if (status === undefined || !sameDisplayNameStyle(status.requested, saved)) {
    return failed ? line(unreadable, 'warning') : line(checking, 'neutral', true);
  }

  switch (status.state) {
    case 'none':
      return null;
    case 'off':
      return line(NAME_STYLE_STATUS_TEXT.off, 'neutral');
    case 'unavailable':
      return line(unavailableText(status.requested), 'warning');
    case 'applying':
      return line(NAME_STYLE_STATUS_TEXT.applying, 'neutral', !pollingOver);
    case 'applied':
      return line(NAME_STYLE_STATUS_TEXT.applied, 'success');
    case 'ignored':
      return line(NAME_STYLE_STATUS_TEXT.refused, 'danger');
    case 'rejected':
      return status.reason === 'missing_change_nickname'
        ? line(NAME_STYLE_STATUS_TEXT.permission, 'danger')
        : line(NAME_STYLE_STATUS_TEXT.refused, 'danger');
    case 'unverified':
      return line(NAME_STYLE_STATUS_TEXT.unconfirmed, 'warning');
  }
}

function outcomeOf(
  status: NameStyleStatus | undefined,
  saved: DisplayNameStyle | null,
): string | null {
  if (status === undefined || status.state === 'applying') return null;
  if (!sameDisplayNameStyle(status.requested, saved)) return null;

  const { lastAttempt, confirmed } = status;
  return [lastAttempt?.attemptedAt, lastAttempt?.updatedAt, confirmed?.confirmedAt].join('|');
}

export function reportsNewOutcome(
  before: NameStyleStatus | undefined,
  after: NameStyleStatus | undefined,
  saved: DisplayNameStyle | null,
): boolean {
  if (before === undefined) return false;

  const next = outcomeOf(after, saved);
  return next !== null && next !== outcomeOf(before, saved);
}

export function discordShowsText(style: ProtonAccount['displayNameStyle']): string | null {
  if (style === undefined) return null;
  if (style === null) return 'Discord shows: No style';

  const view = fromWireStyle(style);
  if (view === null || view.font === null || view.effect === null) {
    return 'Discord shows: a style Proton doesn’t offer';
  }

  return `Discord shows: ${NAME_STYLE_FONT_LABELS[view.font]} · ${NAME_STYLE_EFFECT_LABELS[view.effect]}`;
}

export function pollTimeLeft(startedAt: number, now: number): number {
  return Math.max(0, startedAt + NAME_STYLE_POLL_WINDOW_MS - now);
}

export function NameStyleStatusLine({
  copy,
}: {
  copy: NameStyleStatusCopy | null;
}): ReactElement | null {
  if (copy === null) return null;

  return (
    <span className="name-style-status" data-tone={copy.tone}>
      {copy.busy ? <Spinner size="sm" label={copy.text} showLabel /> : copy.text}
    </span>
  );
}
