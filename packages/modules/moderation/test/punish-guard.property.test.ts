import { describe, expect, test } from 'bun:test';
import { type GuildRole, highestRolePosition } from '@proton/core';
import fc from 'fast-check';
import { PUNISH_KINDS, punishConfigSchema } from '../src/punish/config.ts';
import { guardPunishTarget, immuneRole } from '../src/punish/guard.ts';

const RUNS = { numRuns: 400 };

const OWNER = '200000000000000001';
const ACTOR = '100000000000000001';
const TARGET = '400000000000000001';

const ROLE_IDS = Array.from({ length: 8 }, (_, index) => `41000000000000000${index}`);

const roles = fc
  .array(fc.integer({ min: 0, max: 20 }), {
    minLength: ROLE_IDS.length,
    maxLength: ROLE_IDS.length,
  })
  .map(
    (positions) =>
      new Map<string, GuildRole>(
        ROLE_IDS.map((id, index) => [id, { id, permissions: 0n, position: positions[index] ?? 0 }]),
      ),
  );

const held = fc.subarray(ROLE_IDS);
const kind = fc.constantFrom(...PUNISH_KINDS);

const scenario = fc.record({
  roles,
  actorId: fc.constantFrom(ACTOR, OWNER),
  targetId: fc.constantFrom(TARGET, OWNER, ACTOR),
  actorRoleIds: fc.option(held, { nil: null }),
  targetRoleIds: held,
  kind,
});

describe('guardPunishTarget for any roles, positions and people', () => {
  test('the server owner is never punished, whoever asks', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const refusal = guardPunishTarget({
          ...input,
          targetId: OWNER,
          state: { ownerId: OWNER, roles: input.roles },
        });
        expect(refusal).not.toBeNull();
      }),
      RUNS,
    );
  });

  test('the owner may punish anyone else, whatever roles either of them holds', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        fc.pre(input.targetId !== OWNER);
        const refusal = guardPunishTarget({
          ...input,
          actorId: OWNER,
          state: { ownerId: OWNER, roles: input.roles },
        });
        expect(refusal).toBeNull();
      }),
      RUNS,
    );
  });

  test('unreadable actor roles fail closed for everyone but the owner', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        fc.pre(input.actorId !== OWNER && input.targetId !== OWNER);
        const refusal = guardPunishTarget({
          ...input,
          actorRoleIds: null,
          state: { ownerId: OWNER, roles: input.roles },
        });
        expect(refusal).not.toBeNull();
      }),
      RUNS,
    );
  });

  test('otherwise it refuses exactly when the target ranks at or above the actor', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        fc.pre(input.actorId !== OWNER && input.targetId !== OWNER && input.actorRoleIds !== null);
        const actorRoles = input.actorRoleIds ?? [];

        const refusal = guardPunishTarget({
          ...input,
          state: { ownerId: OWNER, roles: input.roles },
        });

        const outranked =
          highestRolePosition(input.roles, input.targetRoleIds) >=
          highestRolePosition(input.roles, actorRoles);
        expect(refusal !== null).toBe(outranked);
      }),
      RUNS,
    );
  });

  test('a refusal always names the target and never promises that anything happened', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const refusal = guardPunishTarget({
          ...input,
          state: { ownerId: OWNER, roles: input.roles },
        });
        if (refusal === null) return;
        expect(refusal.refusal).toContain(`<@${input.targetId}>`);
        expect(refusal.refusal).toContain('Nothing was done');
      }),
      RUNS,
    );
  });
});

describe('immuneRole for any immunity lists', () => {
  const lists = fc.record({
    global: held,
    ban: held,
    kick: held,
    timeout: held,
    warn: held,
  });

  test('it names a role the target holds from global or that kind’s list, or nothing', () => {
    fc.assert(
      fc.property(lists, held, kind, (immunity, targetRoleIds, punishment) => {
        const config = punishConfigSchema.parse({ immunity });
        const found = immuneRole(config, punishment, targetRoleIds);

        const listed = new Set([...immunity.global, ...immunity[punishment]]);
        const overlap = targetRoleIds.filter((roleId) => listed.has(roleId));

        if (overlap.length === 0) {
          expect(found).toBeNull();
        } else {
          expect(found).not.toBeNull();
          expect(targetRoleIds).toContain(found ?? '');
          expect(listed.has(found ?? '')).toBe(true);
        }
      }),
      RUNS,
    );
  });

  test('another kind’s list never makes a member immune', () => {
    fc.assert(
      fc.property(held, held, kind, kind, (listedRoles, targetRoleIds, listedFor, punishment) => {
        fc.pre(listedFor !== punishment);
        const config = punishConfigSchema.parse({ immunity: { [listedFor]: listedRoles } });

        expect(immuneRole(config, punishment, targetRoleIds)).toBeNull();
      }),
      RUNS,
    );
  });
});
