import { describe, expect, test } from 'bun:test';
import {
  queuedRun,
  SKIP_REASONS,
  skipCountsSchema,
  syncFingerprint,
  syncRunSchema,
  syncRunView,
  syncStatusSchema,
} from '../src/sync/view.ts';
import { BOT_ROLE, config, GUILD, ROLE_LOW, ROLE_MID } from './harness.ts';

const run = queuedRun({
  runId: 'run-1',
  guildId: GUILD,
  kind: 'sync',
  trigger: 'dashboard',
  actorId: '100000000000000001',
  now: 1_000,
});

describe('the sync view', () => {
  test('a queued run survives the JSON round trip Redis puts it through', () => {
    expect(syncRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
    expect(run.total).toBeUndefined();
    expect(run.startedAt).toBeUndefined();
  });

  test('a scheduled run has no actor', () => {
    const scheduled = { ...run, trigger: 'schedule', actorId: null };

    expect(syncRunSchema.parse(JSON.parse(JSON.stringify(scheduled))).actorId).toBeNull();
  });

  test('skip counts name every reason and fill in any a writer left out', () => {
    expect(Object.keys(skipCountsSchema.parse({})).sort()).toEqual([...SKIP_REASONS].sort());
  });

  test('the view the api returns has no cursor and no retry counter', () => {
    const view = syncRunView({ ...run, after: '123456789012345678', failures: 3 });

    expect('after' in view).toBe(false);
    expect('failures' in view).toBe(false);
    expect(
      syncStatusSchema.safeParse({
        run: view,
        last: null,
        estimate: null,
        nextCountAt: null,
        now: 1,
      }).success,
    ).toBe(true);
  });
});

describe('syncFingerprint', () => {
  test('does not care about order or repeats', () => {
    expect(syncFingerprint(config({ memberRoleIds: [ROLE_LOW, ROLE_MID] }))).toBe(
      syncFingerprint(config({ memberRoleIds: [ROLE_MID, ROLE_LOW, ROLE_MID] })),
    );
  });

  test('changes with the roles, the skip roles and the screening wait', () => {
    const base = syncFingerprint(config({ memberRoleIds: [ROLE_LOW] }));

    expect(syncFingerprint(config({ memberRoleIds: [ROLE_MID] }))).not.toBe(base);
    expect(syncFingerprint(config({ memberRoleIds: [ROLE_LOW], botRoleIds: [BOT_ROLE] }))).not.toBe(
      base,
    );
    expect(
      syncFingerprint(
        config({
          memberRoleIds: [ROLE_LOW],
          syncExcludeEnabled: true,
          syncExcludeRoleIds: [ROLE_MID],
        }),
      ),
    ).not.toBe(base);
    expect(
      syncFingerprint(config({ memberRoleIds: [ROLE_LOW], grantWhenScreeningPasses: false })),
    ).not.toBe(base);
  });

  test('ignores skip roles while the switch is off', () => {
    expect(
      syncFingerprint(config({ memberRoleIds: [ROLE_LOW], syncExcludeRoleIds: [ROLE_MID] })),
    ).toBe(syncFingerprint(config({ memberRoleIds: [ROLE_LOW] })));
  });
});
