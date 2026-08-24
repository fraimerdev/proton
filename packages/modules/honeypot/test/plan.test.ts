import { describe, expect, test } from 'bun:test';
import { formatDuration, MAX_TIMEOUT_MS } from '@proton/core';
import { DELETE_SECONDS_MAX, type HoneypotChannel } from '../src/config.ts';
import { planTrap, type TrapPlan, type TrapPlanResult } from '../src/plan.ts';
import { MEMBER, trap } from './harness.ts';

const NOW = Date.parse('2026-08-14T09:01:00.000Z');

function planOf(result: TrapPlanResult): TrapPlan {
  if ('unconfigured' in result) throw new Error(result.unconfigured);
  return result.plan;
}

function unconfigured(result: TrapPlanResult): string {
  if (!('unconfigured' in result)) {
    throw new Error('expected the plan to refuse this channel, but it produced steps');
  }
  return result.unconfigured;
}

describe('planTrap', () => {
  test('plans a softban as a ban and a lift, claimed under different suffixes', () => {
    const plan = planOf(planTrap(trap(), MEMBER, NOW));

    expect(plan.steps).toEqual([
      {
        kind: 'ban',
        payload: { userId: MEMBER, deleteMessageSeconds: DELETE_SECONDS_MAX },
        suffix: 'ban',
      },
      { kind: 'unban', payload: { userId: MEMBER }, suffix: 'unban' },
    ]);
    expect(plan.softban).toBe(true);
    expect(plan.describe).toBe('Softban');
  });

  test('plans a ban with the window and owes no lift', () => {
    const plan = planOf(planTrap(trap({ action: 'ban' }), MEMBER, NOW));

    expect(plan.steps).toEqual([
      {
        kind: 'ban',
        payload: { userId: MEMBER, deleteMessageSeconds: DELETE_SECONDS_MAX },
        suffix: 'ban',
      },
    ]);
    expect(plan.softban).toBe(false);
  });

  test('does not claim to delete messages when the window is zero', () => {
    const plan = planOf(planTrap(trap({ deleteMessageSeconds: 0 }), MEMBER, NOW));

    expect(plan.deletesMessages).toBe(false);
  });

  test("plans nothing at all for 'none'", () => {
    const plan = planOf(planTrap(trap({ action: 'none' }), MEMBER, NOW));

    expect(plan.steps).toEqual([]);
    expect(plan.describe).toBe('Logged only');
  });

  test('names the stored value back when the timeout length cannot be read', () => {
    const broken: HoneypotChannel = { ...trap({ action: 'timeout' }), timeoutDuration: 'soon' };

    const reason = unconfigured(planTrap(broken, MEMBER, NOW));

    expect(reason).toContain("'soon'");
    expect(reason).toContain('s, m, h, d or w');
    expect(reason).toContain('Proton dashboard');
  });

  test('caps a nine-week timeout at the twenty-eight days Discord allows', () => {
    const plan = planOf(planTrap(trap({ action: 'timeout', timeoutDuration: '9w' }), MEMBER, NOW));

    expect(plan.steps).toEqual([
      {
        kind: 'timeout',
        payload: { userId: MEMBER, until: new Date(NOW + MAX_TIMEOUT_MS) },
        suffix: 'timeout',
      },
    ]);
    expect(plan.describe).toBe(`Timeout for ${formatDuration(MAX_TIMEOUT_MS)}`);
  });

  test('leaves a timeout inside the maximum exactly as configured', () => {
    const plan = planOf(planTrap(trap({ action: 'timeout', timeoutDuration: '30m' }), MEMBER, NOW));

    expect(plan.steps).toEqual([
      {
        kind: 'timeout',
        payload: { userId: MEMBER, until: new Date(NOW + 30 * 60 * 1000) },
        suffix: 'timeout',
      },
    ]);
    expect(plan.describe).toBe('Timeout for 30m');
  });
});
