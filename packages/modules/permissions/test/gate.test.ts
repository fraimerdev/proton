import { describe, expect, test } from 'bun:test';
import { liftStoredConfig, permissionsConfigSchema } from '../src/config.ts';
import { evaluateCommandGate, MAX_LISTED_ROLES, requiredRolesFor } from '../src/gate.ts';

const MOD_ROLE = '410000000000000009';
const HELPER_ROLE = '410000000000000007';
const MEMBER_ROLE = '410000000000000001';

function config(overrides: Record<string, string[]>, enabled = true) {
  return permissionsConfigSchema.parse({ enabled, overrides });
}

describe('command overrides', () => {
  test('a command with no override is left to Discord', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [MEMBER_ROLE],
      config: config({ kick: [MOD_ROLE] }),
    });

    expect(decision.allowed).toBe(true);
  });

  test('a member holding one of the required roles may run the command', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [MEMBER_ROLE, MOD_ROLE],
      config: config({ ban: [HELPER_ROLE, MOD_ROLE] }),
    });

    expect(decision.allowed).toBe(true);
  });

  test('a member without the role is refused, and the reason names the role', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [MEMBER_ROLE],
      config: config({ ban: [MOD_ROLE] }),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;

    expect(decision.refusal.code).toBe('missing_required_role');
    expect(decision.refusal.requiredRoleIds).toEqual([MOD_ROLE]);

    expect(decision.refusal.humanReason).toContain(`<@&${MOD_ROLE}>`);
    expect(decision.refusal.humanReason).toContain(MOD_ROLE);
    expect(decision.refusal.humanReason).toContain('/ban');

    expect(decision.refusal.humanReason).toContain('Permissions');
  });

  test('a refusal names every required role when there are several', () => {
    const decision = evaluateCommandGate({
      commandName: 'kick',
      memberRoleIds: [],
      config: config({ kick: [MOD_ROLE, HELPER_ROLE] }),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;

    expect(decision.refusal.humanReason).toContain(`<@&${MOD_ROLE}>`);
    expect(decision.refusal.humanReason).toContain(`<@&${HELPER_ROLE}>`);
  });

  test('a very long role list is summarised rather than overflowing the reply', () => {
    const many = Array.from({ length: 40 }, (_, i) => `4100000000000000${String(10 + i)}`);

    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [],
      config: config({ ban: many }),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;

    expect(decision.refusal.humanReason.length).toBeLessThan(2000);
    expect(decision.refusal.humanReason).toContain(`${many.length - MAX_LISTED_ROLES} other roles`);

    expect(decision.refusal.requiredRoleIds).toHaveLength(many.length);
  });

  test('an override with no roles is not a lockout', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [],
      config: config({ ban: [] }),
    });

    expect(decision.allowed).toBe(true);
  });

  test('switching the module off stops it enforcing anything', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [],
      config: config({ ban: [MOD_ROLE] }, false),
    });

    expect(decision.allowed).toBe(true);
  });

  test('an interaction with no roles at all is refused, not waved through', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [],
      config: config({ ban: [MOD_ROLE] }),
    });

    expect(decision.allowed).toBe(false);
  });
});

describe('overrides left on a command that is now a subcommand', () => {
  test('gate the command that absorbed it, so retiring /untimeout drops no gate', () => {
    const decision = evaluateCommandGate({
      commandName: 'timeout',
      memberRoleIds: [MEMBER_ROLE],
      config: config({ untimeout: [MOD_ROLE] }),
    });

    expect(decision.allowed).toBe(false);
  });

  test.each([
    ['untimeout', 'timeout'],
    ['unquarantine', 'quarantine'],
    ['unlock', 'lockdown'],
  ])('%s is read as %s', (retired, survivor) => {
    expect(requiredRolesFor(config({ [retired]: [MOD_ROLE] }), survivor)).toEqual([MOD_ROLE]);
  });

  // One list has to win — the gate only ever sees the top-level name. The survivor's wins, so the
  // lift widens and the punishment does not. Pinned because it is a decision, not an oversight.
  test('the survivor’s own roles win where both are set, widening only the lift', () => {
    const both = config({ timeout: [MOD_ROLE], untimeout: [HELPER_ROLE] });

    expect(requiredRolesFor(both, 'timeout')).toEqual([MOD_ROLE]);

    expect(
      evaluateCommandGate({ commandName: 'timeout', memberRoleIds: [HELPER_ROLE], config: both })
        .allowed,
    ).toBe(false);
  });

  test('lifting the stored config folds the retired key away for good', () => {
    expect(liftStoredConfig({ enabled: true, overrides: { untimeout: [MOD_ROLE] } })).toEqual({
      enabled: true,
      overrides: { timeout: [MOD_ROLE] },
    });
  });

  test('lifting keeps the survivor’s own roles and still drops the dead key', () => {
    expect(
      liftStoredConfig({
        enabled: true,
        overrides: { timeout: [MOD_ROLE], untimeout: [HELPER_ROLE], ban: [MOD_ROLE] },
      }),
    ).toEqual({ enabled: true, overrides: { timeout: [MOD_ROLE], ban: [MOD_ROLE] } });
  });

  test('lifting leaves a config with nothing to fold exactly as it was', () => {
    const stored = { enabled: true, overrides: { ban: [MOD_ROLE] } };

    expect(liftStoredConfig(stored)).toBe(stored);
    expect(liftStoredConfig(null)).toBeNull();
    expect(liftStoredConfig('nonsense')).toBe('nonsense');
  });
});
