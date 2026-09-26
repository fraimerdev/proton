import type { CommandCatalogueView, CommandSyncFailure, CommandView } from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { Button, cx, Switch } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { useHydrated } from '../../components/ui/overlay.tsx';
import { type CommandGroup, commandHints, commandLabel, noModulesOn } from './list.ts';

export const SWITCH_CAVEAT =
  'When a command or its module is turned off, Discord removes the permissions set for that ' +
  'command in Server Settings → Integrations. Turning it back on doesn’t restore them.';

export const SWITCH_HELP =
  'Discord allows 200 new commands per server per day, and a command turned back on counts as a ' +
  'new one.';

export function CommandListRow({
  command,
  busy,
  failure,
  onToggle,
  onEdit,
}: {
  command: CommandView;
  busy: boolean;
  failure: string | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
}): ReactElement {
  const label = commandLabel(command);
  const hints = commandHints(command);

  return (
    <div className={cx('commands-row', !command.settings.enabled && 'off')}>
      <div className="commands-row-main">
        <span className={cx('commands-row-name', command.kind === 'chat' && 'mono')}>{label}</span>
        {hints.length > 0 ? <span className="commands-row-hint">{hints.join(' · ')}</span> : null}
        {failure !== null ? (
          <p className="field-error" role="alert">
            {failure}
          </p>
        ) : null}
      </div>

      <div className="commands-row-control">
        {command.kind === 'chat' ? (
          <Button size="sm" aria-label={`Edit ${label}`} onClick={onEdit}>
            Edit
          </Button>
        ) : null}
        <Switch
          checked={command.settings.enabled}
          disabled={busy}
          onChange={onToggle}
          label={`Show ${label} in this server`}
        />
      </div>
    </div>
  );
}

export function CommandGroupSection({
  group,
  children,
}: {
  group: CommandGroup;
  children: ReactNode;
}): ReactElement {
  const headingId = `commands-group-${group.id === '' ? 'other' : group.id}`;

  return (
    <section className="commands-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="section-label">
        {group.label}
      </h2>
      <div className="commands-rows">{children}</div>
    </section>
  );
}

function When({ iso }: { iso: string }): ReactElement | null {
  const hydrated = useHydrated();
  if (!hydrated) return null;

  return (
    <> at {new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</>
  );
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function lacksAccess(failure: CommandSyncFailure): boolean {
  return failure.status === 403 || failure.code === '50001';
}

export function CommandBanners({
  view,
  overview,
  inviteHref,
  acknowledging,
  ackFailure,
  onAcknowledge,
}: {
  view: CommandCatalogueView;
  overview: ReactNode;
  inviteHref: string;
  acknowledging: boolean;
  ackFailure: string | null;
  onAcknowledge: () => void;
}): ReactElement | null {
  const { sync, lostPermissions, commands } = view;
  const banners: ReactElement[] = [];

  if (lostPermissions !== null && lostPermissions.commands.length > 0) {
    const names = lostPermissions.commands.map((command) =>
      command.key.includes(':') ? `“${command.name}”` : `/${command.name}`,
    );

    banners.push(
      <StatusBanner
        key="lost"
        tone="warning"
        title="Discord removed some command permissions"
        actions={
          <Button size="sm" busy={acknowledging} onClick={onAcknowledge}>
            Dismiss
          </Button>
        }
      >
        When Proton moved its commands to this server, Discord removed the permissions set for{' '}
        {listed(names)} in Server Settings → Integrations → Proton. Set them again there if you
        still need them.
        {ackFailure !== null ? (
          <span className="commands-banner-error" role="alert">
            {ackFailure}
          </span>
        ) : null}
      </StatusBanner>,
    );
  }

  if (sync.state === 'failed' && sync.failure !== null) {
    banners.push(
      <StatusBanner
        key="failed"
        tone="danger"
        title="The latest command changes haven’t reached Discord"
        actions={
          lacksAccess(sync.failure) ? (
            <a href={inviteHref} className="button button-secondary button-sm">
              Add Proton again
            </a>
          ) : undefined
        }
      >
        {sync.failure.message}
        {sync.failure.retryAt !== null ? (
          <>
            {' '}
            Proton will try again automatically
            <When iso={sync.failure.retryAt} />.
          </>
        ) : null}
        {sync.failure.detail !== '' ? (
          <span className="commands-banner-detail">Discord said: {sync.failure.detail}</span>
        ) : null}
      </StatusBanner>,
    );
  }

  if (sync.state === 'not-this-environment') {
    banners.push(
      <StatusBanner key="environment" tone="neutral">
        This copy of Proton only registers commands in its test server, so changes here are saved
        but not sent to Discord.
      </StatusBanner>,
    );
  }

  if (noModulesOn(commands)) {
    const help = commands.find((command) => command.alwaysRegistered && command.settings.enabled);

    banners.push(
      <StatusBanner key="modules" tone="neutral">
        {help !== undefined
          ? `No modules are on, so members only see /${help.effectiveName} in this server. `
          : 'No modules are on, so members see no Proton commands in this server. '}
        Turn on modules from the {overview}.
      </StatusBanner>,
    );
  }

  return banners.length > 0 ? <div className="page-banners">{banners}</div> : null;
}

export function syncNote(view: CommandCatalogueView): string | null {
  if (view.sync.state === 'pending') {
    return 'Sending these changes to Discord. Members may need a minute to see them.';
  }
  if (view.sync.state === 'unsynced') {
    return 'Proton hasn’t sent this server’s commands to Discord yet.';
  }
  return null;
}
