import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { type ChannelAudienceInput, channelAudience } from '../../src/permissions/audience.ts';
import { has, Permissions } from '../../src/permissions/bits.ts';
import {
  computeChannelPermissions,
  type GuildRole,
  type Overwrite,
} from '../../src/permissions/compute.ts';

const EVERYONE = '900000000000000001';
const OWNER = '100000000000000001';
const OUTSIDER = '100000000000000009';
const ROLE_IDS = [
  '400000000000000001',
  '400000000000000002',
  '400000000000000003',
  '400000000000000004',
  '400000000000000005',
] as const;
const MEMBER_IDS = ['100000000000000002', '100000000000000003', OWNER] as const;

const VIEW = Permissions.ViewChannel;

const BITS = [
  VIEW,
  Permissions.SendMessages,
  Permissions.ReadMessageHistory,
  Permissions.ManageRoles,
];

const bits = fc.subarray(BITS).map((picked) => picked.reduce((acc, bit) => acc | bit, 0n));

const rolePermissions = fc.oneof(
  { weight: 6, arbitrary: bits },
  { weight: 1, arbitrary: fc.constant(Permissions.Administrator) },
);

const role = fc.record({
  permissions: rolePermissions,
  position: fc.integer({ min: 1, max: 20 }),
});

const overwriteTarget = fc.oneof(
  fc.constant({ id: EVERYONE, type: 0 as const }),
  fc.constantFrom(...ROLE_IDS).map((id) => ({ id, type: 0 as const })),
  fc.constantFrom(...MEMBER_IDS).map((id) => ({ id, type: 1 as const })),
);

const overwrites: fc.Arbitrary<Overwrite[]> = fc
  .uniqueArray(fc.record({ target: overwriteTarget, allow: bits, deny: bits }), {
    maxLength: 8,
    selector: ({ target }) => target.id,
  })
  .map((list) => list.map(({ target, allow, deny }) => ({ ...target, allow, deny })));

const scene: fc.Arbitrary<ChannelAudienceInput> = fc
  .record({
    everyone: rolePermissions,
    roles: fc.array(role, { minLength: ROLE_IDS.length, maxLength: ROLE_IDS.length }),
    overwrites,
  })
  .map(({ everyone, roles, overwrites: list }) => {
    const map = new Map<string, GuildRole>([
      [EVERYONE, { id: EVERYONE, permissions: everyone, position: 0 }],
    ]);
    ROLE_IDS.forEach((id, index) => {
      const role = roles[index] ?? { permissions: 0n, position: 1 };
      map.set(id, { id, ...role });
    });
    return { roles: map, everyoneRoleId: EVERYONE, ownerId: OWNER, overwrites: list };
  });

function canView(
  input: ChannelAudienceInput,
  memberId: string,
  roleIds: readonly string[],
): boolean {
  return has(
    computeChannelPermissions(
      {
        guildOwnerId: input.ownerId,
        everyoneRoleId: input.everyoneRoleId,
        memberId,
        memberRoleIds: roleIds,
        roles: input.roles,
      },
      input.overwrites,
    ),
    VIEW,
  );
}

function documentedCanView(
  input: ChannelAudienceInput,
  memberId: string,
  roleIds: readonly string[],
): boolean {
  if (memberId === input.ownerId) return true;

  let base = input.roles.get(input.everyoneRoleId)?.permissions ?? 0n;
  for (const id of roleIds) base |= input.roles.get(id)?.permissions ?? 0n;
  if ((base & Permissions.Administrator) === Permissions.Administrator) return true;

  const byId = new Map(input.overwrites.map((overwrite) => [overwrite.id, overwrite]));
  let permissions = base;

  const everyone = byId.get(input.everyoneRoleId);
  if (everyone) {
    permissions &= ~everyone.deny;
    permissions |= everyone.allow;
  }

  let allow = 0n;
  let deny = 0n;
  for (const id of roleIds) {
    const overwrite = byId.get(id);
    if (overwrite) {
      allow |= overwrite.allow;
      deny |= overwrite.deny;
    }
  }
  permissions &= ~deny;
  permissions |= allow;

  const member = byId.get(memberId);
  if (member) {
    permissions &= ~member.deny;
    permissions |= member.allow;
  }

  return (permissions & VIEW) === VIEW;
}

describe('channelAudience properties', () => {
  test('agrees with Discord’s documented overwrite algorithm, written out here on its own', () => {
    fc.assert(
      fc.property(scene, fc.subarray([...ROLE_IDS]), (input, held) => {
        const audience = channelAudience(input);
        const listed = new Set([...audience.roleIds, ...audience.administratorRoleIds]);

        const rolesAgree =
          audience.everyone === documentedCanView(input, OUTSIDER, []) &&
          ROLE_IDS.every((id) => listed.has(id) === documentedCanView(input, OUTSIDER, [id]));
        const covered =
          !documentedCanView(input, OUTSIDER, held) ||
          audience.everyone ||
          held.some((id) => listed.has(id));
        const membersSee = audience.memberIds.every((id) => documentedCanView(input, id, held));

        return rolesAgree && covered && membersSee;
      }),
      { numRuns: 1000 },
    );
  });

  test('anyone without a member overwrite who can see the channel is covered by a listed role', () => {
    fc.assert(
      fc.property(scene, fc.subarray([...ROLE_IDS]), (input, held) => {
        if (!canView(input, OUTSIDER, held)) return true;

        const audience = channelAudience(input);
        const listed = new Set([...audience.roleIds, ...audience.administratorRoleIds]);
        return audience.everyone || held.some((id) => listed.has(id));
      }),
      { numRuns: 1000 },
    );
  });

  test('a role is listed exactly when a member holding only it can see the channel', () => {
    fc.assert(
      fc.property(scene, (input) => {
        const audience = channelAudience(input);
        const listed = new Set([...audience.roleIds, ...audience.administratorRoleIds]);

        return (
          audience.everyone === canView(input, OUTSIDER, []) &&
          ROLE_IDS.every((id) => listed.has(id) === canView(input, OUTSIDER, [id]))
        );
      }),
      { numRuns: 1000 },
    );
  });

  test('Administrator roles are listed apart, and only they are', () => {
    fc.assert(
      fc.property(scene, (input) => {
        const audience = channelAudience(input);
        const admins = new Set(audience.administratorRoleIds);

        return (
          ROLE_IDS.every(
            (id) =>
              admins.has(id) ===
              has(input.roles.get(id)?.permissions ?? 0n, Permissions.Administrator),
          ) &&
          audience.roleIds.every((id) => !admins.has(id)) &&
          !audience.roleIds.includes(EVERYONE) &&
          !audience.administratorRoleIds.includes(EVERYONE)
        );
      }),
      { numRuns: 1000 },
    );
  });

  test('a listed member can see the channel whatever roles they hold', () => {
    fc.assert(
      fc.property(scene, fc.subarray([...ROLE_IDS]), (input, held) => {
        const audience = channelAudience(input);
        return audience.memberIds.every((id) => canView(input, id, held));
      }),
      { numRuns: 1000 },
    );
  });

  test('lists only members the channel names, and only those it allows in', () => {
    fc.assert(
      fc.property(scene, (input) => {
        const allowed = input.overwrites
          .filter((o) => o.type === 1 && has(o.allow, VIEW))
          .map((o) => o.id);

        return [...channelAudience(input).memberIds].sort().join() === [...allowed].sort().join();
      }),
      { numRuns: 1000 },
    );
  });

  test('the order Discord returns overwrites in changes nothing', () => {
    fc.assert(
      fc.property(
        scene.chain((input) => {
          const all = input.overwrites.length;
          const shuffled = fc.shuffledSubarray([...input.overwrites], {
            minLength: all,
            maxLength: all,
          });
          return fc.tuple(fc.constant(input), shuffled);
        }),
        ([input, shuffled]) => {
          const before = channelAudience(input);
          const after = channelAudience({ ...input, overwrites: shuffled });

          return (
            before.everyone === after.everyone &&
            before.roleIds.join() === after.roleIds.join() &&
            before.administratorRoleIds.join() === after.administratorRoleIds.join() &&
            [...before.memberIds].sort().join() === [...after.memberIds].sort().join()
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  test('allowing a role the view on the channel always lists it', () => {
    fc.assert(
      fc.property(scene, fc.constantFrom(...ROLE_IDS), (input, roleId) => {
        const opened = channelAudience({
          ...input,
          overwrites: [
            ...input.overwrites.filter((o) => o.id !== roleId),
            { id: roleId, type: 0, allow: VIEW, deny: 0n },
          ],
        });

        return opened.roleIds.includes(roleId) || opened.administratorRoleIds.includes(roleId);
      }),
      { numRuns: 500 },
    );
  });
});
