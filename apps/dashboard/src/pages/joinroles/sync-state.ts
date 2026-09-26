import type { JoinrolesConfig } from '@proton/module-joinroles/config';
import {
  type BlockedRole,
  type GrantRefusalCode,
  isStaleRun,
  type JoinRolesSyncStatus,
  type LastSync,
  type SkipCounts,
  type SkipReason,
  type SyncFailure,
  type SyncRunView,
  syncFingerprint,
} from '@proton/module-joinroles/sync-view';
import type { GuildRole } from '../../lib/discord.ts';

export type SavedSyncConfig = Pick<
  JoinrolesConfig,
  | 'memberRoleIds'
  | 'botRoleIds'
  | 'grantWhenScreeningPasses'
  | 'syncExcludeEnabled'
  | 'syncExcludeRoleIds'
>;

export interface SyncPanelForm {
  enabled: boolean;
  dirty: boolean;
  saved: SavedSyncConfig;
  roleNames?: ReadonlyMap<string, string> | undefined;
}

export interface RoleLine {
  roleId: string;
  text: string;
}

export type RunPhase = 'idle' | 'queued' | 'running';

export interface SyncPanelState {
  sync: {
    canStart: boolean;
    disabledReason: string | null;
    phase: RunPhase;
    status: string | null;
    details: string[];
    stalled: string | null;
    stale: boolean;
    error: string | null;
    roles: RoleLine[];
  };
  count: {
    canStart: boolean;
    disabledReason: string | null;
    label: 'Count' | 'Count again';
    phase: RunPhase;
    value: string | null;
    note: string | null;
    stalled: string | null;
    stale: boolean;
    error: string | null;
  };
  last: {
    value: string;
  };
}

export const STALL_MS = 2 * 60_000;

export const SYNC_DESCRIPTION =
  'Give the member and bot roles to everyone already in the server who doesn’t have them.';

export const SYNC_IDLE = 'No sync is running.';
export const SYNC_QUEUED = 'Asked Proton to start. The sync begins within a few seconds.';
export const COUNT_QUEUED = 'Asked Proton to count. The count begins within a few seconds.';

export const SYNC_OFF = 'Turn Join Roles on to sync.';
export const COUNT_OFF = 'Turn Join Roles on to count.';
export const NO_ROLES = 'Choose member or bot roles first.';
export const SYNC_UNSAVED = 'Save your changes first. A sync uses the saved settings.';
export const COUNT_UNSAVED = 'Save your changes first. A count uses the saved settings.';
export const COUNT_RUNNING = 'A count is running. You can sync when it finishes.';
export const SYNC_RUNNING = 'A sync is running. You can count when it finishes.';
export const SYNC_RESTART = 'You can start a new sync.';
export const COUNT_RESTART = 'You can start a new count.';

export const NEVER_COUNTED = 'Not counted yet';
export const NEVER_SYNCED = 'Never';
export const STALE_COUNT = 'Your settings changed after this count.';
export const UNEXPLAINED = 'The last sync didn’t finish, and no reason was recorded. Sync again.';

const NUMBER = new Intl.NumberFormat('en-US');

function n(value: number): string {
  return NUMBER.format(value);
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function members(count: number): string {
  return `${n(count)} ${plural(count, 'member')}`;
}

function tallyOf(done: number, total: number | undefined): string {
  if (total === undefined || total < done) return members(done);
  return `${n(done)} of about ${members(total)}`;
}

export function syncWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function syncClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} ${plural(minutes, 'minute')}`;

  const hours = Math.floor(minutes / 60);
  return `${hours} ${plural(hours, 'hour')}`;
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'minute')} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'hour')} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'day')} ago`;
}

function skippedTotal(skipped: SkipCounts): number {
  return Object.values(skipped).reduce((sum, count) => sum + count, 0);
}

const SKIP_ORDER: readonly SkipReason[] = [
  'pending',
  'excluded',
  'outranks',
  'owner',
  'left',
  'failed',
];

const SKIP_LINE: Record<SkipReason, (count: number) => string> = {
  pending: (count) =>
    count === 1
      ? '1 is waiting for Membership Screening and gets their roles when they finish it.'
      : `${n(count)} are waiting for Membership Screening and get their roles when they finish it.`,
  excluded: (count) =>
    count === 1 ? '1 has a role you chose to skip.' : `${n(count)} have a role you chose to skip.`,
  outranks: (count) =>
    count === 1
      ? '1 ranks above Proton, so Proton can’t change their roles.'
      : `${n(count)} rank above Proton, so Proton can’t change their roles.`,
  owner: (count) => (count === 1 ? '1 is the server owner.' : `${n(count)} are the server owner.`),
  left: (count) => `${n(count)} left the server during the sync.`,
  failed: (count) =>
    count === 1
      ? '1 couldn’t be given every role. The next sync tries again.'
      : `${n(count)} couldn’t be given every role. The next sync tries them again.`,
};

export function skipLines(skipped: SkipCounts): string[] {
  return SKIP_ORDER.filter((reason) => skipped[reason] > 0).map((reason) =>
    SKIP_LINE[reason](skipped[reason]),
  );
}

const NOT_GIVEN: Record<GrantRefusalCode, (name: string) => string> = {
  everyone: () => 'Not given: @everyone, which every member already has.',
  missing: (name) => `Not given: ${name} no longer exists.`,
  managed: (name) => `Not given: ${name} is managed by Discord or an integration.`,
  above_proton: (name) => `Not given: ${name} is above Proton’s role.`,
};

function roleName(roleId: string, names: ReadonlyMap<string, string> | undefined): string {
  return names?.get(roleId) ?? `the role ${roleId}`;
}

export function notGivenLines(
  blocked: readonly BlockedRole[],
  names: ReadonlyMap<string, string> | undefined,
): RoleLine[] {
  return blocked.map(({ roleId, code }) => ({
    roleId,
    text: NOT_GIVEN[code](roleName(roleId, names)),
  }));
}

export function ungivableRoles(
  saved: Pick<SavedSyncConfig, 'memberRoleIds' | 'botRoleIds'>,
  guildId: string,
  roles: readonly Pick<GuildRole, 'id' | 'name' | 'managed' | 'assignable'>[] | undefined,
): RoleLine[] {
  if (roles === undefined) return [];

  const byId = new Map(roles.map((role) => [role.id, role]));
  const names = new Map(roles.map((role) => [role.id, role.name]));
  const blocked: BlockedRole[] = [];

  for (const roleId of new Set([...saved.memberRoleIds, ...saved.botRoleIds])) {
    // fetchGuildRoles drops @everyone, so it is recognised by id before the lookup calls it missing.
    if (roleId === guildId) {
      blocked.push({ roleId, code: 'everyone' });
      continue;
    }

    const role = byId.get(roleId);
    if (role === undefined) blocked.push({ roleId, code: 'missing' });
    else if (role.managed) blocked.push({ roleId, code: 'managed' });
    else if (!role.assignable) blocked.push({ roleId, code: 'above_proton' });
  }

  return notGivenLines(blocked, names);
}

export function syncConfirmBody(saved: SavedSyncConfig): string {
  const forMembers = saved.memberRoleIds.length > 0;
  const forBots = saved.botRoleIds.length > 0;

  const parts = [
    forMembers && forBots
      ? 'Proton gives the member roles to every member and the bot roles to every bot that is missing them.'
      : forBots
        ? 'Proton gives the bot roles to every bot that is missing them.'
        : 'Proton gives the member roles to every member who is missing them.',
  ];

  if (saved.syncExcludeEnabled && saved.syncExcludeRoleIds.length > 0) {
    parts.push('Members with a role you chose to skip are left alone.');
  }

  if (forMembers && saved.grantWhenScreeningPasses) {
    parts.push('Members still in Membership Screening get their roles when they finish it.');
  }

  parts.push('Anyone who had one of these roles removed by hand gets it back.');
  parts.push('The sync runs in the background and you can leave this page.');

  return parts.join(' ');
}

function failureText(failure: SyncFailure, names: ReadonlyMap<string, string> | undefined): string {
  const name = failure.roleId === undefined ? undefined : names?.get(failure.roleId);
  if (name === undefined) return failure.message;

  if (failure.code === 'role_refused') {
    return `Discord refused to give ${name}, so the sync stopped. Proton’s role may have been moved below it.`;
  }

  if (failure.code === 'role_above_proton') {
    return `The join role ${name} is now at or above Proton’s highest role, so the sync stopped there. Drag Proton’s role above it in Server Settings → Roles.`;
  }

  return failure.message;
}

function outcome(last: LastSync): string | null {
  if (last.outcome === 'done') {
    return `Finished. ${members(last.updated)} updated, ${n(skippedTotal(last.skipped))} skipped.`;
  }

  if (last.outcome === 'stopped') {
    return last.failure?.code === 'switched_off'
      ? `Stopped after ${members(last.processed)} because Join Roles was turned off.`
      : `Stopped after ${members(last.processed)}.`;
  }

  return null;
}

function lastValue(last: LastSync | null): string {
  if (last === null) return NEVER_SYNCED;

  const scheduled = last.trigger === 'schedule' ? ' (scheduled)' : '';
  const when = syncWhen(last.finishedAt);

  if (last.outcome === 'done') return `${when} · ${members(last.updated)} updated${scheduled}`;

  if (last.outcome === 'stopped') {
    return `${when} · Stopped after ${members(last.processed)}${scheduled}`;
  }

  return `${when} · Didn’t finish${scheduled}`;
}

function stalledFor(run: SyncRunView, now: number, restart: string): string | null {
  const quiet = now - run.heartbeatAt;
  if (quiet < STALL_MS) return null;

  const line = `No progress reported for ${span(quiet)}.`;
  return isStaleRun(run, now) ? `${line} ${restart}` : line;
}

function estimateValue(missing: number, pending: number): string {
  if (missing === 0) return 'None';

  const about = `About ${n(missing)}`;
  if (pending === 0) return about;
  if (pending >= missing) return `${about}, all still in Membership Screening`;

  return `${about} (${n(pending)} of them ${pending === 1 ? 'is' : 'are'} still in Membership Screening)`;
}

export function syncPanelState(status: JoinRolesSyncStatus, form: SyncPanelForm): SyncPanelState {
  const { run, last, estimate, nextCountAt, now } = status;
  const names = form.roleNames;
  const hasRoles = form.saved.memberRoleIds.length + form.saved.botRoleIds.length > 0;

  const stale = run !== null && isStaleRun(run, now);
  const syncRun = run?.kind === 'sync' ? run : null;
  const countRun = run?.kind === 'count' ? run : null;

  const syncReason = !form.enabled
    ? SYNC_OFF
    : form.dirty
      ? SYNC_UNSAVED
      : !hasRoles
        ? NO_ROLES
        : countRun !== null && !stale
          ? COUNT_RUNNING
          : null;

  const cooling = nextCountAt !== null && nextCountAt > now;

  const countReason = !form.enabled
    ? COUNT_OFF
    : form.dirty
      ? COUNT_UNSAVED
      : !hasRoles
        ? NO_ROLES
        : syncRun !== null && !stale
          ? SYNC_RUNNING
          : (countRun === null || stale) && cooling
            ? `You can count again at ${syncClock(nextCountAt)}.`
            : null;

  let sync: SyncPanelState['sync'];

  if (syncRun !== null) {
    const skipped = skippedTotal(syncRun.skipped);

    sync = {
      canStart: stale && syncReason === null,
      disabledReason: syncReason,
      phase: syncRun.state,
      status:
        syncRun.state === 'queued'
          ? SYNC_QUEUED
          : `Checked ${tallyOf(syncRun.processed, syncRun.total)}. ${n(syncRun.updated)} updated, ${n(skipped)} skipped.`,
      details: skipLines(syncRun.skipped),
      stalled: stalledFor(syncRun, now, SYNC_RESTART),
      stale,
      error: null,
      roles: notGivenLines(syncRun.blockedRoles, names),
    };
  } else {
    const failed = last?.outcome === 'failed';

    sync = {
      canStart: syncReason === null,
      disabledReason: syncReason,
      phase: 'idle',
      status:
        last !== null ? outcome(last) : syncReason === null && countRun === null ? SYNC_IDLE : null,
      details: last !== null && !failed ? skipLines(last.skipped) : [],
      stalled: null,
      stale: false,
      error: !failed
        ? null
        : last.failure !== null
          ? failureText(last.failure, names)
          : UNEXPLAINED,
      roles: last !== null ? notGivenLines(last.blockedRoles, names) : [],
    };
  }

  let count: SyncPanelState['count'];

  if (countRun !== null) {
    count = {
      canStart: stale && countReason === null,
      disabledReason: countReason,
      label: estimate === null ? 'Count' : 'Count again',
      phase: countRun.state,
      value:
        countRun.state === 'queued'
          ? COUNT_QUEUED
          : `Counting… ${tallyOf(countRun.processed, countRun.total)} read`,
      note: null,
      stalled: stalledFor(countRun, now, COUNT_RESTART),
      stale,
      error: null,
    };
  } else if (estimate === null) {
    count = {
      canStart: countReason === null,
      disabledReason: countReason,
      label: 'Count',
      phase: 'idle',
      value: NEVER_COUNTED,
      note: null,
      stalled: null,
      stale: false,
      error: null,
    };
  } else if (estimate.failure !== null) {
    count = {
      canStart: countReason === null,
      disabledReason: countReason,
      label: 'Count again',
      phase: 'idle',
      value: null,
      note: null,
      stalled: null,
      stale: false,
      error: failureText(estimate.failure, names),
    };
  } else {
    const how =
      estimate.source === 'count' ? 'by reading the member list' : 'at the end of the last sync';
    // Not estimate.stale: that was judged at the last poll, and a save since then has moved it.
    const changed = estimate.fingerprint !== syncFingerprint(form.saved);

    count = {
      canStart: countReason === null,
      disabledReason: countReason,
      label: 'Count again',
      phase: 'idle',
      value: estimateValue(estimate.missing, estimate.pending),
      note: `Counted ${ago(now - estimate.countedAt)} ${how}.${changed ? ` ${STALE_COUNT}` : ''}`,
      stalled: null,
      stale: false,
      error: null,
    };
  }

  return { sync, count, last: { value: lastValue(last) } };
}
