import { describe, expect, test } from 'bun:test';
import {
  type JoinRolesSyncStatus,
  queuedRun,
  SYNC_STALE_MS,
  type SyncRunView,
  syncFingerprint,
  syncRunView,
  syncStatusSchema,
} from '@proton/module-joinroles/sync-view';
import {
  COUNT_OFF,
  COUNT_QUEUED,
  COUNT_RESTART,
  COUNT_RUNNING,
  COUNT_UNSAVED,
  NEVER_COUNTED,
  NEVER_SYNCED,
  NO_ROLES,
  type SavedSyncConfig,
  STALE_COUNT,
  SYNC_IDLE,
  SYNC_OFF,
  SYNC_QUEUED,
  SYNC_RESTART,
  SYNC_RUNNING,
  SYNC_UNSAVED,
  type SyncPanelForm,
  syncClock,
  syncConfirmBody,
  syncPanelState,
  syncWhen,
  UNEXPLAINED,
  ungivableRoles,
} from '../src/pages/joinroles/sync-state.ts';

const GUILD = '900000000000000002';
const ACTOR = '400000000000000001';
const MEMBER_ROLE = '500000000000000001';
const BOT_ROLE = '500000000000000002';
const SKIP_ROLE = '500000000000000003';
const HIGH_ROLE = '500000000000000004';

const NOW = Date.parse('2026-09-18T14:00:00.000Z');
const MINUTE = 60_000;

const SAVED: SavedSyncConfig = {
  memberRoleIds: [MEMBER_ROLE],
  botRoleIds: [BOT_ROLE],
  grantWhenScreeningPasses: true,
  syncExcludeEnabled: false,
  syncExcludeRoleIds: [],
};

const FORM: SyncPanelForm = {
  enabled: true,
  dirty: false,
  saved: SAVED,
  roleNames: new Map([
    [MEMBER_ROLE, 'Member'],
    [BOT_ROLE, 'Bots'],
    [HIGH_ROLE, 'Staff'],
  ]),
};

const SKIPPED = { excluded: 0, pending: 0, outranks: 0, owner: 0, left: 0, failed: 0 };

// Through JSON and the schema, as the api client reads it: undefined keys vanish on the wire.
function status(patch: Record<string, unknown> = {}): JoinRolesSyncStatus {
  return syncStatusSchema.parse(
    JSON.parse(
      JSON.stringify({
        run: null,
        last: null,
        estimate: null,
        nextCountAt: null,
        now: NOW,
        ...patch,
      }),
    ),
  );
}

function run(patch: Partial<SyncRunView> = {}): SyncRunView {
  return {
    ...syncRunView(
      queuedRun({
        runId: 'r1',
        guildId: GUILD,
        kind: 'sync',
        trigger: 'dashboard',
        actorId: ACTOR,
        now: NOW - MINUTE,
      }),
    ),
    ...patch,
  };
}

function running(patch: Partial<SyncRunView> = {}): SyncRunView {
  return run({
    state: 'running',
    startedAt: NOW - MINUTE,
    heartbeatAt: NOW - 5_000,
    total: 5000,
    processed: 1200,
    updated: 84,
    ...patch,
  });
}

function last(patch: Record<string, unknown> = {}) {
  return {
    runId: 'r0',
    trigger: 'dashboard',
    outcome: 'done',
    failure: null,
    processed: 5000,
    updated: 312,
    skipped: { ...SKIPPED, pending: 4, excluded: 10 },
    blockedRoles: [],
    startedAt: NOW - 60 * MINUTE,
    finishedAt: NOW - 50 * MINUTE,
    ...patch,
  };
}

function estimate(patch: Record<string, unknown> = {}) {
  return {
    missing: 312,
    pending: 20,
    scanned: 5000,
    countedAt: NOW - 2 * 60 * MINUTE,
    source: 'count',
    fingerprint: syncFingerprint(SAVED),
    failure: null,
    stale: false,
    ...patch,
  };
}

describe('syncPanelState when nothing is running', () => {
  test('idle says no sync is running and offers both actions', () => {
    const state = syncPanelState(status(), FORM);

    expect(state.sync).toEqual({
      canStart: true,
      disabledReason: null,
      phase: 'idle',
      status: SYNC_IDLE,
      details: [],
      stalled: null,
      stale: false,
      error: null,
      roles: [],
    });
    expect(state.count.canStart).toBe(true);
    expect(state.count.label).toBe('Count');
    expect(state.count.value).toBe(NEVER_COUNTED);
    expect(state.count.note).toBeNull();
    expect(state.last.value).toBe(NEVER_SYNCED);
  });

  test('a switched-off module names the switch for both actions, ahead of any other reason', () => {
    const state = syncPanelState(status(), { ...FORM, enabled: false, dirty: true });

    expect(state.sync.canStart).toBe(false);
    expect(state.sync.disabledReason).toBe(SYNC_OFF);
    expect(state.sync.status).toBeNull();
    expect(state.count.canStart).toBe(false);
    expect(state.count.disabledReason).toBe(COUNT_OFF);
  });

  test('unsaved changes block both, because a run reads the saved settings', () => {
    const state = syncPanelState(status(), { ...FORM, dirty: true });

    expect(state.sync.disabledReason).toBe(SYNC_UNSAVED);
    expect(state.count.disabledReason).toBe(COUNT_UNSAVED);
    expect(state.sync.canStart).toBe(false);
    expect(state.count.canStart).toBe(false);
  });

  test('unsaved roles say save first rather than set roles first', () => {
    const empty = { ...SAVED, memberRoleIds: [], botRoleIds: [] };
    const state = syncPanelState(status(), { ...FORM, dirty: true, saved: empty });

    expect(state.sync.disabledReason).toBe(SYNC_UNSAVED);
  });

  test('no saved member or bot roles leaves nothing to sync or count', () => {
    const empty = { ...SAVED, memberRoleIds: [], botRoleIds: [] };
    const state = syncPanelState(status(), { ...FORM, saved: empty });

    expect(state.sync.disabledReason).toBe(NO_ROLES);
    expect(state.count.disabledReason).toBe(NO_ROLES);
  });

  test('bot roles alone are enough to sync', () => {
    const bots = { ...SAVED, memberRoleIds: [] };

    expect(syncPanelState(status(), { ...FORM, saved: bots }).sync.canStart).toBe(true);
  });
});

describe('syncPanelState while a sync runs', () => {
  test('queued says Proton was asked and blocks another start and a count', () => {
    const state = syncPanelState(status({ run: run() }), FORM);

    expect(state.sync.phase).toBe('queued');
    expect(state.sync.status).toBe(SYNC_QUEUED);
    expect(state.sync.canStart).toBe(false);
    expect(state.count.canStart).toBe(false);
    expect(state.count.disabledReason).toBe(SYNC_RUNNING);
  });

  test('running reports members checked, updated and skipped, and why each was skipped', () => {
    const skipped = { ...SKIPPED, pending: 4, excluded: 2, outranks: 3, owner: 1, left: 5 };
    const state = syncPanelState(status({ run: running({ skipped }) }), FORM);

    expect(state.sync.phase).toBe('running');
    expect(state.sync.status).toBe('Checked 1,200 of about 5,000 members. 84 updated, 15 skipped.');
    expect(state.sync.details).toEqual([
      '4 are waiting for Membership Screening and get their roles when they finish it.',
      '2 have a role you chose to skip.',
      '3 rank above Proton, so Proton can’t change their roles.',
      '1 is the server owner.',
      '5 left the server during the sync.',
    ]);
    expect(state.sync.stalled).toBeNull();
  });

  test('one of each reason reads in the singular', () => {
    const skipped = { ...SKIPPED, pending: 1, excluded: 1, outranks: 1, failed: 1 };
    const state = syncPanelState(status({ run: running({ skipped }) }), FORM);

    expect(state.sync.details).toEqual([
      '1 is waiting for Membership Screening and gets their roles when they finish it.',
      '1 has a role you chose to skip.',
      '1 ranks above Proton, so Proton can’t change their roles.',
      '1 couldn’t be given every role. The next sync tries again.',
    ]);
  });

  test('without a member total, or past it, the count stands alone', () => {
    const unknown = syncPanelState(status({ run: running({ total: undefined }) }), FORM);
    const grown = syncPanelState(status({ run: running({ total: 1000 }) }), FORM);

    expect(unknown.sync.status).toBe('Checked 1,200 members. 84 updated, 0 skipped.');
    expect(grown.sync.status).toBe('Checked 1,200 members. 84 updated, 0 skipped.');
  });

  test('roles the run found it cannot give are named, one line each', () => {
    const blockedRoles = [{ roleId: HIGH_ROLE, code: 'above_proton' as const }];
    const state = syncPanelState(status({ run: running({ blockedRoles }) }), FORM);

    expect(state.sync.roles).toEqual([
      { roleId: HIGH_ROLE, text: 'Not given: Staff is above Proton’s role.' },
    ]);
  });

  test('two minutes without a heartbeat is reported as no progress', () => {
    const quiet = syncPanelState(
      status({ run: running({ heartbeatAt: NOW - 3 * MINUTE - 10_000 }) }),
      FORM,
    );
    const fresh = syncPanelState(
      status({ run: running({ heartbeatAt: NOW - 2 * MINUTE + 1_000 }) }),
      FORM,
    );
    const hours = syncPanelState(status({ run: run({ heartbeatAt: NOW - 125 * MINUTE }) }), FORM);

    expect(quiet.sync.stalled).toBe('No progress reported for 3 minutes.');
    expect(fresh.sync.stalled).toBeNull();
    expect(hours.sync.stalled).toBe(`No progress reported for 2 hours. ${SYNC_RESTART}`);
  });

  test('a run silent for the whole stale window can be replaced by a new sync or count', () => {
    const state = syncPanelState(
      status({ run: running({ heartbeatAt: NOW - SYNC_STALE_MS }) }),
      FORM,
    );

    expect(state.sync.stale).toBe(true);
    expect(state.sync.canStart).toBe(true);
    expect(state.sync.phase).toBe('running');
    expect(state.sync.stalled).toBe(`No progress reported for 10 minutes. ${SYNC_RESTART}`);
    expect(state.count.canStart).toBe(true);
    expect(state.count.disabledReason).toBeNull();
  });

  test('a run heard from just inside the window still blocks a new start', () => {
    const state = syncPanelState(
      status({ run: running({ heartbeatAt: NOW - SYNC_STALE_MS + 1_000 }) }),
      FORM,
    );

    expect(state.sync.stale).toBe(false);
    expect(state.sync.canStart).toBe(false);
    expect(state.sync.stalled).toBe('No progress reported for 9 minutes.');
    expect(state.count.disabledReason).toBe(SYNC_RUNNING);
  });

  test('a stale run still waits for saved settings before it can be replaced', () => {
    const state = syncPanelState(status({ run: run({ heartbeatAt: NOW - SYNC_STALE_MS }) }), {
      ...FORM,
      dirty: true,
    });

    expect(state.sync.canStart).toBe(false);
    expect(state.sync.disabledReason).toBe(SYNC_UNSAVED);
  });

  test('a stale count can be replaced by a sync or a new count', () => {
    const state = syncPanelState(
      status({
        run: running({ kind: 'count', heartbeatAt: NOW - 3 * 60 * MINUTE }),
        estimate: estimate({ countedAt: NOW - 20 * MINUTE }),
      }),
      FORM,
    );

    expect(state.sync.canStart).toBe(true);
    expect(state.sync.disabledReason).toBeNull();
    expect(state.count.canStart).toBe(true);
    expect(state.count.stale).toBe(true);
    expect(state.count.stalled).toBe(`No progress reported for 3 hours. ${COUNT_RESTART}`);
  });

  test('a disabled reason is not shown as the status of a running sync', () => {
    const state = syncPanelState(status({ run: running() }), { ...FORM, dirty: true });

    expect(state.sync.status).toContain('Checked');
    expect(state.sync.canStart).toBe(false);
  });

  test('the error of an earlier failed sync is hidden while a new one runs', () => {
    const failed = last({
      outcome: 'failed',
      failure: { code: 'missing_permission', message: 'Proton is missing Manage Roles.' },
    });
    const state = syncPanelState(status({ run: running(), last: failed }), FORM);

    expect(state.sync.error).toBeNull();
  });
});

describe('syncPanelState after a sync', () => {
  test('done reports members updated and skipped, and keeps the reasons', () => {
    const state = syncPanelState(status({ last: last() }), FORM);

    expect(state.sync.phase).toBe('idle');
    expect(state.sync.canStart).toBe(true);
    expect(state.sync.status).toBe('Finished. 312 members updated, 14 skipped.');
    expect(state.sync.details).toEqual([
      '4 are waiting for Membership Screening and get their roles when they finish it.',
      '10 have a role you chose to skip.',
    ]);
    expect(state.last.value).toBe(`${syncWhen(NOW - 50 * MINUTE)} · 312 members updated`);
  });

  test('a scheduled sync says so in the last sync row', () => {
    const state = syncPanelState(status({ last: last({ trigger: 'schedule', updated: 1 }) }), FORM);

    expect(state.last.value).toBe(`${syncWhen(NOW - 50 * MINUTE)} · 1 member updated (scheduled)`);
  });

  test('failed shows the worker’s message as the error, with each blocked role on its own line', () => {
    const failed = last({
      outcome: 'failed',
      updated: 0,
      failure: { code: 'roles_blocked', message: 'None of the join roles can be given.' },
      blockedRoles: [
        { roleId: HIGH_ROLE, code: 'above_proton' },
        { roleId: BOT_ROLE, code: 'managed' },
        { roleId: '500000000000000009', code: 'missing' },
        { roleId: GUILD, code: 'everyone' },
      ],
    });
    const state = syncPanelState(status({ last: failed }), FORM);

    expect(state.sync.error).toBe('None of the join roles can be given.');
    expect(state.sync.status).toBeNull();
    expect(state.sync.details).toEqual([]);
    expect(state.sync.roles.map((line) => line.text)).toEqual([
      'Not given: Staff is above Proton’s role.',
      'Not given: Bots is managed by Discord or an integration.',
      'Not given: the role 500000000000000009 no longer exists.',
      'Not given: @everyone, which every member already has.',
    ]);
    expect(state.sync.canStart).toBe(true);
    expect(state.last.value).toBe(`${syncWhen(NOW - 50 * MINUTE)} · Didn’t finish`);
  });

  test('a refused role is named from the server’s roles, and the worker’s words kept when unknown', () => {
    const refused = (roleId: string) =>
      last({
        outcome: 'failed',
        failure: {
          code: 'role_refused',
          roleId,
          message: 'Discord refused to give one of the join roles, so the sync stopped.',
        },
      });

    expect(syncPanelState(status({ last: refused(HIGH_ROLE) }), FORM).sync.error).toBe(
      'Discord refused to give Staff, so the sync stopped. Proton’s role may have been moved below it.',
    );
    expect(syncPanelState(status({ last: refused('500000000000000009') }), FORM).sync.error).toBe(
      'Discord refused to give one of the join roles, so the sync stopped.',
    );
  });

  test('a role now above Proton is named, and a deleted role keeps its ID', () => {
    const stopped = (code: string, roleId: string, message: string) =>
      last({ outcome: 'failed', failure: { code, roleId, message } });

    expect(
      syncPanelState(
        status({
          last: stopped(
            'role_above_proton',
            HIGH_ROLE,
            `The join role with ID ${HIGH_ROLE} is now at or above Proton's highest role.`,
          ),
        }),
        FORM,
      ).sync.error,
    ).toBe(
      'The join role Staff is now at or above Proton’s highest role, so the sync stopped there. ' +
        'Drag Proton’s role above it in Server Settings → Roles.',
    );

    const deleted =
      'The join role with ID 500000000000000009 no longer exists, so the sync stopped there.';
    expect(
      syncPanelState(status({ last: stopped('role_missing', '500000000000000009', deleted) }), FORM)
        .sync.error,
    ).toBe(deleted);
  });

  test('a failed sync with no recorded reason still says it did not finish', () => {
    const state = syncPanelState(status({ last: last({ outcome: 'failed' }) }), FORM);

    expect(state.sync.error).toBe(UNEXPLAINED);
    expect(state.sync.status).toBeNull();
  });

  test('stopped by the switch says how far it got', () => {
    const stopped = last({
      outcome: 'stopped',
      processed: 1200,
      failure: { code: 'switched_off', message: 'Join Roles was turned off.' },
    });
    const state = syncPanelState(status({ last: stopped }), FORM);

    expect(state.sync.status).toBe(
      'Stopped after 1,200 members because Join Roles was turned off.',
    );
    expect(state.sync.error).toBeNull();
    expect(state.last.value).toBe(`${syncWhen(NOW - 50 * MINUTE)} · Stopped after 1,200 members`);
  });
});

describe('syncPanelState for the count', () => {
  test('a count that has not started yet says Proton was asked, and blocks a sync', () => {
    const state = syncPanelState(status({ run: run({ kind: 'count' }) }), FORM);

    expect(state.count.phase).toBe('queued');
    expect(state.count.value).toBe(COUNT_QUEUED);
    expect(state.sync.canStart).toBe(false);
    expect(state.sync.disabledReason).toBe(COUNT_RUNNING);
    expect(state.sync.status).toBeNull();
  });

  test('a running count reports members read and keeps its button busy', () => {
    const counting = running({ kind: 'count', processed: 3000, updated: 0 });
    const state = syncPanelState(status({ run: counting, estimate: estimate() }), FORM);

    expect(state.count.phase).toBe('running');
    expect(state.count.value).toBe('Counting… 3,000 of about 5,000 members read');
    expect(state.count.canStart).toBe(false);
    expect(state.count.label).toBe('Count again');
    expect(state.sync.disabledReason).toBe(COUNT_RUNNING);
  });

  test('never counted offers Count', () => {
    const state = syncPanelState(status(), FORM);

    expect(state.count.value).toBe(NEVER_COUNTED);
    expect(state.count.label).toBe('Count');
  });

  test('an estimate gives the number, the screening share and when it was counted', () => {
    const state = syncPanelState(status({ estimate: estimate() }), FORM);

    expect(state.count.value).toBe('About 312 (20 of them are still in Membership Screening)');
    expect(state.count.note).toBe('Counted 2 hours ago by reading the member list.');
    expect(state.count.label).toBe('Count again');
  });

  test('an estimate left by a sync says so, and small numbers read naturally', () => {
    const none = syncPanelState(
      status({ estimate: estimate({ missing: 0, pending: 0, source: 'sync' }) }),
      FORM,
    );
    const one = syncPanelState(
      status({ estimate: estimate({ missing: 3, pending: 1, countedAt: NOW - 10_000 }) }),
      FORM,
    );
    const all = syncPanelState(status({ estimate: estimate({ missing: 4, pending: 4 }) }), FORM);

    expect(none.count.value).toBe('None');
    expect(none.count.note).toBe('Counted 2 hours ago at the end of the last sync.');
    expect(one.count.value).toBe('About 3 (1 of them is still in Membership Screening)');
    expect(one.count.note).toBe('Counted just now by reading the member list.');
    expect(all.count.value).toBe('About 4, all still in Membership Screening');
  });

  test('an estimate from before the roles changed is marked stale', () => {
    const changed = { ...SAVED, memberRoleIds: [MEMBER_ROLE, HIGH_ROLE] };
    const skipping = { ...SAVED, syncExcludeEnabled: true, syncExcludeRoleIds: [SKIP_ROLE] };

    expect(syncPanelState(status({ estimate: estimate() }), FORM).count.note).not.toContain(
      STALE_COUNT,
    );
    expect(
      syncPanelState(status({ estimate: estimate() }), { ...FORM, saved: changed }).count.note,
    ).toBe(`Counted 2 hours ago by reading the member list. ${STALE_COUNT}`);
    expect(
      syncPanelState(status({ estimate: estimate() }), { ...FORM, saved: skipping }).count.note,
    ).toContain(STALE_COUNT);
  });

  test('staleness is judged against the settings the page shows as saved, not the last poll', () => {
    const polledBeforeARevert = estimate({ stale: true });

    expect(
      syncPanelState(status({ estimate: polledBeforeARevert }), FORM).count.note,
    ).not.toContain(STALE_COUNT);
  });

  test('a failed count shows its failure instead of numbers', () => {
    const failure = {
      code: 'member_list_refused',
      message: "Discord wouldn't let Proton read the member list.",
    };
    const state = syncPanelState(status({ estimate: estimate({ failure }) }), FORM);

    expect(state.count.value).toBeNull();
    expect(state.count.note).toBeNull();
    expect(state.count.error).toBe(failure.message);
    expect(state.count.label).toBe('Count again');
  });

  test('the cooldown keeps Count off until the time it names, then lets it go', () => {
    const next = NOW + 5 * MINUTE;
    const cooling = syncPanelState(status({ estimate: estimate(), nextCountAt: next }), FORM);
    const over = syncPanelState(
      status({ estimate: estimate(), nextCountAt: next, now: next + 1 }),
      FORM,
    );

    expect(cooling.count.canStart).toBe(false);
    expect(cooling.count.disabledReason).toBe(`You can count again at ${syncClock(next)}.`);
    expect(cooling.sync.canStart).toBe(true);
    expect(over.count.canStart).toBe(true);
    expect(over.count.disabledReason).toBeNull();
  });
});

describe('the confirm dialog', () => {
  test('says what a sync does, with the screening and skip sentences only when they apply', () => {
    expect(syncConfirmBody(SAVED)).toBe(
      'Proton gives the member roles to every member and the bot roles to every bot that is ' +
        'missing them. Members still in Membership Screening get their roles when they finish ' +
        'it. Anyone who had one of these roles removed by hand gets it back. The sync runs in ' +
        'the background and you can leave this page.',
    );

    const skipping = {
      ...SAVED,
      grantWhenScreeningPasses: false,
      syncExcludeEnabled: true,
      syncExcludeRoleIds: [SKIP_ROLE],
    };
    expect(syncConfirmBody(skipping)).toContain(
      'Members with a role you chose to skip are left alone.',
    );
    expect(syncConfirmBody(skipping)).not.toContain('Membership Screening');

    expect(syncConfirmBody({ ...SAVED, syncExcludeEnabled: true })).not.toContain('skip');
    expect(syncConfirmBody({ ...SAVED, memberRoleIds: [] })).toStartWith(
      'Proton gives the bot roles to every bot that is missing them.',
    );
  });

  test('lists the saved roles the page already knows Proton cannot give', () => {
    const roles = [
      { id: MEMBER_ROLE, name: 'Member', managed: false, assignable: true },
      { id: BOT_ROLE, name: 'Bots', managed: true, assignable: true },
      { id: HIGH_ROLE, name: 'Staff', managed: false, assignable: false },
    ];
    const saved = {
      ...SAVED,
      memberRoleIds: [MEMBER_ROLE, HIGH_ROLE, '500000000000000009', GUILD],
      botRoleIds: [BOT_ROLE, HIGH_ROLE],
    };

    expect(ungivableRoles(saved, GUILD, roles).map((line) => line.text)).toEqual([
      'Not given: Staff is above Proton’s role.',
      'Not given: the role 500000000000000009 no longer exists.',
      'Not given: @everyone, which every member already has.',
      'Not given: Bots is managed by Discord or an integration.',
    ]);
    expect(ungivableRoles(saved, GUILD, undefined)).toEqual([]);
  });
});
