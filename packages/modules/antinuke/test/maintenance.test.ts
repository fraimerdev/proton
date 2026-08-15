import { describe, expect, test } from 'bun:test';
import {
  hasLapsed,
  isCoveredByMaintenance,
  isMaintenanceRefusal,
  type MaintenanceWindow,
  maintenanceWindowSchema,
  planMaintenance,
} from '../src/maintenance.ts';
import { GUILD, NOW } from './harness.ts';

const ADMIN = '100000000000000001';

function plan(durationMs: number, maxDurationMs = 3_600_000) {
  return planMaintenance({
    guildId: GUILD,
    enabledBy: ADMIN,
    reason: 'moving channels',
    durationMs,
    maxDurationMs,
    now: NOW,
  });
}

describe('planning a maintenance window', () => {
  test('turns a duration into an absolute expiry', () => {
    const planned = plan(20 * 60_000);

    expect(isMaintenanceRefusal(planned)).toBe(false);
    expect(planned).toEqual({
      guildId: GUILD,
      enabledBy: ADMIN,
      reason: 'moving channels',
      startedAt: NOW,
      expiresAt: NOW + 20 * 60_000,
    });
  });

  test('refuses a window longer than the guild allows, naming both durations', () => {
    const planned = plan(4 * 3_600_000, 3_600_000);

    expect(isMaintenanceRefusal(planned)).toBe(true);
    if (!isMaintenanceRefusal(planned)) return;
    expect(planned.refusal).toContain('caps maintenance mode at 1h');
    expect(planned.refusal).toContain('asked for 4h');
  });

  test('refuses a window that expires the moment it opens', () => {
    expect(isMaintenanceRefusal(plan(0))).toBe(true);
  });
});

describe('what a window covers', () => {
  const window: MaintenanceWindow = {
    guildId: GUILD,
    enabledBy: ADMIN,
    reason: null,
    startedAt: NOW,
    expiresAt: NOW + 60_000,
  };

  test('covers acts performed inside it, from the first millisecond', () => {
    expect(isCoveredByMaintenance(window, NOW)).toBe(true);
    expect(isCoveredByMaintenance(window, NOW + 59_999)).toBe(true);
  });

  test('covers nothing outside it, at either end', () => {
    expect(isCoveredByMaintenance(window, NOW - 1)).toBe(false);
    // Exclusive: an act at the expiry instant is after the window, not in it.
    expect(isCoveredByMaintenance(window, window.expiresAt)).toBe(false);
  });

  test('judges coverage by when the act happened, not by the clock', () => {
    // The entry arrives ten minutes late, long after the window closed. It is
    // still covered, because the admin was authorised when they did it.
    const late = NOW + 30_000;
    expect(isCoveredByMaintenance(window, late)).toBe(true);
    expect(hasLapsed(window, NOW + 10 * 60_000)).toBe(true);
  });

  test('lapses at the expiry instant and not before', () => {
    expect(hasLapsed(window, window.expiresAt - 1)).toBe(false);
    expect(hasLapsed(window, window.expiresAt)).toBe(true);
  });
});

describe('the stored shape', () => {
  test('refuses a record that is not a window, so corruption cannot disarm the breaker', () => {
    expect(maintenanceWindowSchema.safeParse({ guildId: GUILD }).success).toBe(false);
    expect(
      maintenanceWindowSchema.safeParse({
        guildId: GUILD,
        enabledBy: 'not-a-snowflake',
        reason: null,
        startedAt: NOW,
        expiresAt: NOW + 1,
      }).success,
    ).toBe(false);
  });
});
