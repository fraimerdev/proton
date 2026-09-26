import type { JoinrolesConfig, SyncInterval } from '@proton/module-joinroles/config';
import { joinrolesConfigSchema } from '@proton/module-joinroles/config';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { LimitCounter } from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  cx,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from '../../components/ui/controls.tsx';
import { Spinner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { failureKind, readFailure, saveFailure } from '../../lib/errors.ts';
import { joinrolesSyncQuery, rolesQuery, startJoinRolesSyncMutation } from '../../lib/queries.ts';
import {
  type RoleLine,
  type RunPhase,
  SYNC_DESCRIPTION,
  type SyncPanelState,
  syncConfirmBody,
  syncPanelState,
  ungivableRoles,
} from './sync-state.ts';

type Form = ModuleForm<JoinrolesConfig>;

const TICK_MS = 15_000;

const SKIP_DESCRIPTION =
  'Members with any of these roles are left out of a sync, like an unverified or quarantine role.';

const SKIP_HELP = 'Only syncs skip them. New members still get their join roles.';

const SCHEDULE_HELP =
  'If a sync or count is already running, the scheduled sync tries again an hour later.';

const INTERVAL_HELP =
  'The first scheduled sync runs a day or a week after you turn this on. Changing how often ' +
  'starts the wait again.';

const INTERVAL_OPTIONS: readonly SegmentedOption<SyncInterval>[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}

// Not saveFailure alone: the api's refusals say why, and saveFailure would replace them.
function refusal(error: Error, attempt: string): string {
  return failureKind(error) === 'unknown' && error.message !== ''
    ? error.message
    : saveFailure(error, attempt);
}

function StatusRow({
  title,
  description,
  control,
  children,
}: {
  title: string;
  description?: string | undefined;
  control?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">{title}</div>
        {description !== undefined ? <p className="row-description">{description}</p> : null}
        {children}
      </div>
      {control !== undefined ? <div className="row-control">{control}</div> : null}
    </div>
  );
}

function ErrorLine({ text }: { text: string | null }): ReactElement | null {
  if (text === null) return null;

  return (
    <p className="row-error" role="alert">
      {text}
    </p>
  );
}

function NoteLine({
  text,
  className,
}: {
  text: string | null;
  className?: string | undefined;
}): ReactElement | null {
  if (text === null) return null;
  return <p className={cx('row-note', className)}>{text}</p>;
}

// One region that stays mounted across phases: a live region mounted with its text is not read.
function Progress({
  phase,
  text,
  label,
  className,
}: {
  phase: RunPhase;
  text: string | null;
  label: string;
  className: string;
}): ReactElement {
  return (
    <div aria-live="polite">
      {text === null ? null : phase === 'queued' ? (
        <p className="row-note joinroles-sync-progress">
          <Icon name="circle-notch" size={14} className="button-spin" />
          <span>{text}</span>
        </p>
      ) : phase === 'running' ? (
        <p className={cx(className, 'joinroles-sync-progress')}>
          <Spinner label={label} />
          <span>{text}</span>
        </p>
      ) : (
        <p className={className}>{text}</p>
      )}
    </div>
  );
}

function RoleLines({ lines }: { lines: readonly RoleLine[] }): ReactElement | null {
  if (lines.length === 0) return null;

  return (
    <ul className="joinroles-issues joinroles-sync-lines">
      {lines.map((line) => (
        <li key={line.roleId}>
          <Icon name="warning" size={13} weight="fill" />
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

function DetailLines({ lines }: { lines: readonly string[] }): ReactElement | null {
  if (lines.length === 0) return null;

  return (
    <ul className="joinroles-sync-details">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function Loading(): ReactElement {
  return (
    <p className="row-note">
      <Spinner label="Loading sync status" />
    </p>
  );
}

function SyncNowRow({
  state,
  readError,
  startError,
  busy,
  onStart,
}: {
  state: SyncPanelState['sync'] | null;
  readError: string | null;
  startError: string | null;
  busy: boolean;
  onStart: () => void;
}): ReactElement {
  const ready = state?.phase === 'idle' || state?.stale === true;

  return (
    <StatusRow
      title="Sync now"
      description={SYNC_DESCRIPTION}
      control={
        <Button
          tone="primary"
          size="sm"
          busy={busy}
          disabled={state === null || !state.canStart}
          onClick={onStart}
        >
          Sync now
        </Button>
      }
    >
      {state === null ? (
        readError !== null ? (
          <ErrorLine text={readError} />
        ) : (
          <Loading />
        )
      ) : (
        <>
          <ErrorLine text={ready && startError !== null ? startError : state.error} />
          <Progress
            phase={state.phase}
            text={state.status}
            label="Sync running"
            className="row-note"
          />
          <DetailLines lines={state.details} />
          <RoleLines lines={state.roles} />
          <NoteLine text={state.stalled} className="joinroles-sync-stalled" />
          <NoteLine text={ready ? state.disabledReason : null} />
        </>
      )}
    </StatusRow>
  );
}

function CountRow({
  state,
  loading,
  startError,
  busy,
  onCount,
}: {
  state: SyncPanelState['count'] | null;
  loading: boolean;
  startError: string | null;
  busy: boolean;
  onCount: () => void;
}): ReactElement {
  const ready = state?.phase === 'idle' || state?.stale === true;

  return (
    <StatusRow
      title="Members missing a join role"
      control={
        <Button
          size="sm"
          busy={busy}
          disabled={state === null || !state.canStart}
          onClick={onCount}
        >
          {state?.label ?? 'Count'}
        </Button>
      }
    >
      {state === null ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          <Progress
            phase={state.phase}
            text={state.value}
            label="Count running"
            className="joinroles-sync-value"
          />
          <ErrorLine text={ready && startError !== null ? startError : state.error} />
          <NoteLine text={state.note} />
          <NoteLine text={state.stalled} className="joinroles-sync-stalled" />
          <NoteLine text={ready ? state.disabledReason : null} />
        </>
      )}
    </StatusRow>
  );
}

function SkipRows({ form, guildId }: { form: Form; guildId: string }): ReactElement {
  const skipRoles = form.value.syncExcludeRoleIds;
  const skipError = form.errorAt('syncExcludeRoleIds');

  return (
    <>
      <SettingRow
        title="Skip members with certain roles"
        description={SKIP_DESCRIPTION}
        help={SKIP_HELP}
        error={form.errorAt('syncExcludeEnabled')}
      >
        <Switch
          label="Skip members with certain roles"
          checked={form.value.syncExcludeEnabled}
          onChange={(next) => form.set('syncExcludeEnabled', next)}
        />
      </SettingRow>

      {form.value.syncExcludeEnabled ? (
        <SettingRow
          title="Roles to skip"
          badge={<LimitCounter used={skipRoles.length} ceiling={25} label="roles" />}
          error={skipError}
          stacked
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Roles to skip"
            value={skipRoles}
            max={25}
            invalid={skipError !== undefined}
            onChange={(next) => form.set('syncExcludeRoleIds', next)}
          />
        </SettingRow>
      ) : null}
    </>
  );
}

function ScheduleRows({ form }: { form: Form }): ReactElement {
  return (
    <>
      <SettingRow
        title="Sync on a schedule"
        badge={<Badge tone="info">Beta</Badge>}
        help={SCHEDULE_HELP}
        error={form.errorAt('syncScheduleEnabled')}
      >
        <Switch
          label="Sync on a schedule"
          checked={form.value.syncScheduleEnabled}
          onChange={(next) => form.set('syncScheduleEnabled', next)}
        />
      </SettingRow>

      {form.value.syncScheduleEnabled ? (
        <SettingRow title="How often" help={INTERVAL_HELP} error={form.errorAt('syncInterval')}>
          <SegmentedControl<SyncInterval>
            label="How often"
            options={INTERVAL_OPTIONS}
            value={form.value.syncInterval}
            onChange={(next) => form.set('syncInterval', next)}
          />
        </SettingRow>
      ) : null}
    </>
  );
}

export function SyncArea({
  form,
  guildId,
  enabled,
}: {
  form: Form;
  guildId: string;
  enabled: boolean;
}): ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery(joinrolesSyncQuery(guildId));
  const roles = useQuery(rolesQuery(guildId));
  const tick = useClock();
  const [confirming, setConfirming] = useState(false);

  const sync = useMutation({
    ...startJoinRolesSyncMutation(queryClient, guildId),
    onSuccess: () => setConfirming(false),
    onError: () => setConfirming(false),
  });

  const count = useMutation(startJoinRolesSyncMutation(queryClient, guildId));

  const data = query.data;
  const runId = data?.run?.runId;
  const resetSync = sync.reset;
  const resetCount = count.reset;

  // A refusal answered one attempt; left in place it would reappear under the next idle state.
  useEffect(() => {
    if (runId === undefined) return;
    resetSync();
    resetCount();
  }, [runId, resetSync, resetCount]);

  const saved = useMemo(() => {
    const parsed = joinrolesConfigSchema.safeParse(form.view.config);
    return parsed.success ? parsed.data : form.value;
  }, [form.view.config, form.value]);

  const roleNames = useMemo(
    () => new Map((roles.data ?? []).map((role) => [role.id, role.name])),
    [roles.data],
  );

  const skew = data === undefined ? 0 : data.now - query.dataUpdatedAt;
  const now = Math.max(tick, query.dataUpdatedAt) + skew;

  const state =
    data === undefined
      ? null
      : syncPanelState({ ...data, now }, { enabled, dirty: form.dirty, saved, roleNames });

  const readError =
    data === undefined && query.isError ? readFailure(query.error, 'the sync status') : null;
  const loading = data === undefined && readError === null;

  return (
    <Section label="Existing members">
      <Rows>
        <SyncNowRow
          state={state?.sync ?? null}
          readError={readError}
          startError={sync.error ? refusal(sync.error, 'The sync wasn’t started') : null}
          busy={sync.isPending}
          onStart={() => setConfirming(true)}
        />

        <CountRow
          state={state?.count ?? null}
          loading={loading}
          startError={count.error ? refusal(count.error, 'The count wasn’t started') : null}
          busy={count.isPending}
          onCount={() => count.mutate('count')}
        />

        <StatusRow title="Last sync">
          {state !== null ? (
            <p className="joinroles-sync-value">{state.last.value}</p>
          ) : loading ? (
            <Loading />
          ) : null}
        </StatusRow>

        <SkipRows form={form} guildId={guildId} />

        <ScheduleRows form={form} />
      </Rows>

      <ConfirmDialog
        open={confirming}
        title="Sync join roles?"
        confirmLabel="Start sync"
        busy={sync.isPending}
        onClose={() => setConfirming(false)}
        onConfirm={() => sync.mutate('sync')}
      >
        {syncConfirmBody(saved)}
        {ungivableRoles(saved, guildId, roles.data).map((line) => (
          <span key={line.roleId} className="joinroles-sync-notgiven">
            <Icon name="warning" size={13} weight="fill" />
            <span>{line.text}</span>
          </span>
        ))}
      </ConfirmDialog>
    </Section>
  );
}
