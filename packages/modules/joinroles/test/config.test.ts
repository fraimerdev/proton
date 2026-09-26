import { describe, expect, test } from 'bun:test';
import {
  JOINROLES_SCHEMA_VERSION,
  joinrolesConfigSchema,
  joinrolesDefaultConfig,
  MAX_SYNC_EXCLUDE_ROLES,
} from '../src/config.ts';
import { joinrolesModule } from '../src/index.ts';
import { BOT_ROLE, ROLE_LOW, ROLE_MID } from './harness.ts';

const STORED_V2 = {
  enabled: true,
  memberRoleIds: [ROLE_LOW, ROLE_MID],
  botRoleIds: [BOT_ROLE],
  grantWhenScreeningPasses: false,
  stickyEnabled: true,
  stickyRoleIds: [ROLE_MID],
};

function roleIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(700000000000001000n + BigInt(i)));
}

describe('join roles config v3', () => {
  test('is schema version 3, on the manifest too', () => {
    expect(JOINROLES_SCHEMA_VERSION).toBe(3);
    expect(joinrolesModule.schemaVersion).toBe(3);
  });

  test('a stored v2 row parses with the sync settings off and every role list intact', () => {
    const parsed = joinrolesConfigSchema.parse(STORED_V2);

    expect(parsed).toEqual({
      ...STORED_V2,
      syncExcludeEnabled: false,
      syncExcludeRoleIds: [],
      syncScheduleEnabled: false,
      syncInterval: 'weekly',
    });
  });

  test('a stored v2 row survives being switched off and on again', () => {
    const first = joinrolesConfigSchema.parse(STORED_V2);
    const off = joinrolesConfigSchema.parse(
      JSON.parse(JSON.stringify({ ...first, enabled: false })),
    );
    const on = joinrolesConfigSchema.parse(JSON.parse(JSON.stringify({ ...off, enabled: true })));

    expect(on).toEqual(first);
    expect(on.memberRoleIds).toEqual(STORED_V2.memberRoleIds);
    expect(on.botRoleIds).toEqual(STORED_V2.botRoleIds);
    expect(on.stickyRoleIds).toEqual(STORED_V2.stickyRoleIds);
  });

  test('skip roles are capped', () => {
    expect(
      joinrolesConfigSchema.safeParse({ syncExcludeRoleIds: roleIds(MAX_SYNC_EXCLUDE_ROLES) })
        .success,
    ).toBe(true);
    expect(
      joinrolesConfigSchema.safeParse({ syncExcludeRoleIds: roleIds(MAX_SYNC_EXCLUDE_ROLES + 1) })
        .success,
    ).toBe(false);
    expect(MAX_SYNC_EXCLUDE_ROLES).toBe(25);
  });

  test('the interval is daily or weekly, weekly by default', () => {
    expect(joinrolesDefaultConfig.syncInterval).toBe('weekly');
    expect(joinrolesConfigSchema.safeParse({ syncInterval: 'daily' }).success).toBe(true);
    expect(joinrolesConfigSchema.safeParse({ syncInterval: 'monthly' }).success).toBe(false);
  });

  test('the defaults leave sync switched off', () => {
    expect(joinrolesDefaultConfig.syncExcludeEnabled).toBe(false);
    expect(joinrolesDefaultConfig.syncScheduleEnabled).toBe(false);
  });
});
