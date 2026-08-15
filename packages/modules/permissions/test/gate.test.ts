import { describe, expect, test } from 'bun:test';
import { permissionsConfigSchema } from '../src/config.ts';
import { evaluateCommandGate, MAX_LISTED_ROLES } from '../src/gate.ts';

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

  /** The whole point of the module: a refusal that names what is missing (§1). */
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
    // The mention renders as the role's name; the id follows it for the admin
    // who has to find the override.
    expect(decision.refusal.humanReason).toContain(`<@&${MOD_ROLE}>`);
    expect(decision.refusal.humanReason).toContain(MOD_ROLE);
    expect(decision.refusal.humanReason).toContain('/ban');
    // Names where to change it, not only that it was refused.
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

  /**
   * An interaction reply is capped at 2000 characters. A refusal that listed a
   * hundred roles would be rejected by the executor's payload validation and the
   * invoker would be told nothing at all.
   */
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
    // The structured reason still carries all of them, for logs and the dashboard.
    expect(decision.refusal.requiredRoleIds).toHaveLength(many.length);
  });

  /**
   * A role picker emptied of its last role must relax the override. Reading an
   * empty list as "nobody" would lock the command for the entire guild — from a
   * config change that looks like a removal.
   */
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

  /** A DM interaction carries no member, and a guild role cannot be held outside it. */
  test('an interaction with no roles at all is refused, not waved through', () => {
    const decision = evaluateCommandGate({
      commandName: 'ban',
      memberRoleIds: [],
      config: config({ ban: [MOD_ROLE] }),
    });

    expect(decision.allowed).toBe(false);
  });
});
