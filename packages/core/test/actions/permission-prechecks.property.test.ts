import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { DedupeStore } from '../../src/actions/dedupe.ts';
import { DefaultActionExecutor } from '../../src/actions/executor.ts';
import {
  ACTION_KINDS,
  type ActionKind,
  hierarchyApplies,
  refusedOnAdministrators,
  requiredPermissionsFor,
} from '../../src/actions/kinds.ts';
import { runPrechecks } from '../../src/actions/prechecks.ts';
import {
  type MemberRolesLookup,
  type ResolveContextHints,
  type ResolveContextResult,
  resolvePrecheckContext,
} from '../../src/actions/resolve-context.ts';
import type { RestRequestOptions, RestResponse } from '../../src/actions/rest-client.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type { GuildState, GuildStateStore } from '../../src/guild-state/types.ts';
import { invitePermissionsFor } from '../../src/modules/registry.ts';
import { ALL_PERMISSIONS, has, Permissions, permissionLabels } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const MEMBER = '100000000000000001';
const BOT_ROLE = '410000000000000005';
const MEMBER_ROLE = '410000000000000001';
const SUBJECT_ROLE = '410000000000000007';
const UNCACHED_ROLE = '410000000000000099';

const KNOWN_BITS = fc.bigInt({ min: 0n, max: (1n << 53n) - 1n });
const WITHOUT_ADMINISTRATOR = KNOWN_BITS.map((bits) => bits & ~Permissions.Administrator);
const rarely = fc.integer({ min: 0, max: 9 }).map((n) => n === 0);

type Target = 'owner' | 'bot' | 'member';
const TARGET_IDS: Record<Target, string> = { owner: OWNER, bot: BOT, member: MEMBER };
const target = fc.constantFrom<Target>('owner', 'bot', 'member');

const RANKED_KINDS = ACTION_KINDS.filter(hierarchyApplies);
const ADMINISTRATOR_BLIND_KINDS = RANKED_KINDS.filter((kind) => !refusedOnAdministrators(kind));

const shape = fc.record({
  everyone: WITHOUT_ADMINISTRATOR,
  everyoneAdministrator: rarely,
  botPermissions: KNOWN_BITS,
  botPosition: fc.integer({ min: 0, max: 40 }),
  memberPermissions: WITHOUT_ADMINISTRATOR,
  memberAdministrator: fc.boolean(),
  memberPosition: fc.integer({ min: 0, max: 40 }),
  subjectPosition: fc.integer({ min: 0, max: 40 }),
});

type Shape = {
  everyone: bigint;
  everyoneAdministrator: boolean;
  botPermissions: bigint;
  botPosition: number;
  memberPermissions: bigint;
  memberAdministrator: boolean;
  memberPosition: number;
  subjectPosition: number;
};

function everyoneBits(s: Shape): bigint {
  return s.everyone | (s.everyoneAdministrator ? Permissions.Administrator : 0n);
}

function memberBits(s: Shape): bigint {
  return s.memberPermissions | (s.memberAdministrator ? Permissions.Administrator : 0n);
}

function botBase(s: Shape): bigint {
  return everyoneBits(s) | s.botPermissions;
}

function botHolds(s: Shape, required: bigint): boolean {
  return has(botBase(s), Permissions.Administrator) || has(botBase(s), required);
}

function targetIsAdministrator(s: Shape): boolean {
  return has(everyoneBits(s) | memberBits(s), Permissions.Administrator);
}

function guildState(s: Shape): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: everyoneBits(s), position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: s.botPermissions, position: s.botPosition }],
      [MEMBER_ROLE, { id: MEMBER_ROLE, permissions: memberBits(s), position: s.memberPosition }],
      [SUBJECT_ROLE, { id: SUBJECT_ROLE, permissions: 0n, position: s.subjectPosition }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(),
    updatedAt: Date.now(),
  };
}

function store(state: GuildState): GuildStateStore {
  return {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

function request(kind: ActionKind, targetId: string | undefined, payload: unknown): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind,
    actorId: '100000000000000077',
    dryRun: false,
    idempotencyKey: `k-${kind}`,
    payload,
    ...(targetId ? { targetId } : {}),
  };
}

function payloadFor(kind: ActionKind, targetId: string, roleId = SUBJECT_ROLE): unknown {
  if (kind === 'timeout') return { userId: targetId, until: new Date(Date.now() + 60_000) };
  if (kind === 'add_role' || kind === 'remove_role') return { userId: targetId, roleId };
  return { userId: targetId };
}

async function resolve(
  s: Shape,
  req: ActionRequest,
  hints: ResolveContextHints = { targetRoleIds: [MEMBER_ROLE] },
  lookup: MemberRolesLookup = [MEMBER_ROLE],
): Promise<{ result: ResolveContextResult; lookups: number }> {
  let lookups = 0;
  const result = await resolvePrecheckContext(
    {
      store: store(guildState(s)),
      botUserId: BOT,
      fetchMemberRoles: async () => {
        lookups += 1;
        return lookup;
      },
    },
    req,
    hints,
  );
  return { result, lookups };
}

function refusal(result: ResolveContextResult): { code: string; humanReason: string } | null {
  if ('failure' in result) return result.failure;
  return runPrechecks(result.context);
}

describe('a timeout on a member who holds Administrator', () => {
  test('is refused by name, after Proton itself and the owner, and before their rank', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ActionKind>('timeout', 'untimeout'),
        shape,
        target,
        async (kind, s, who) => {
          const id = TARGET_IDS[who];
          const { result } = await resolve(s, request(kind, id, payloadFor(kind, id)));
          const failure = refusal(result);

          const expected = !botHolds(s, Permissions.ModerateMembers)
            ? 'missing_permission'
            : who === 'bot'
              ? 'target_is_self'
              : who === 'owner'
                ? 'target_is_owner'
                : targetIsAdministrator(s)
                  ? 'target_is_administrator'
                  : s.memberPosition >= s.botPosition
                    ? 'role_hierarchy'
                    : null;

          if ((failure?.code ?? null) !== expected) return false;
          return (
            expected !== 'target_is_administrator' ||
            failure?.humanReason.includes('Administrator') === true
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  test('changes nothing for any other ranked kind, which Discord allows on an Administrator', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ADMINISTRATOR_BLIND_KINDS),
        shape.map((s) => ({ ...s, everyoneAdministrator: false })),
        target,
        async (kind, s, who) => {
          const id = TARGET_IDS[who];
          const req = request(kind, id, payloadFor(kind, id));
          const plain = await resolve({ ...s, memberAdministrator: false }, req);
          const administrator = await resolve({ ...s, memberAdministrator: true }, req);

          const exempted =
            'context' in administrator.result &&
            administrator.result.context.target?.exemptAsAdministrator !== undefined;

          return (
            !exempted &&
            Bun.deepEquals(refusal(plain.result), refusal(administrator.result)) &&
            refusal(administrator.result)?.code !== 'target_is_administrator'
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  test('reaches Discord from neither execute nor precheck', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ActionKind>('timeout', 'untimeout'),
        shape.map((s) => ({
          ...s,
          botPermissions: s.botPermissions | Permissions.ModerateMembers,
          memberAdministrator: true,
        })),
        async (kind, s) => {
          const calls: RestRequestOptions[] = [];
          const executor = new DefaultActionExecutor({
            dedupe: memoryDedupe(),
            rest: {
              request: async (options): Promise<RestResponse> => {
                calls.push(options);
                return { status: 204, body: null };
              },
            },
            recorder: { record: async () => ({ caseId: 'case' }) },
            resolveContext: async (req, hints) => {
              const resolved = await resolvePrecheckContext(
                { store: store(guildState(s)), botUserId: BOT },
                req,
                (hints ?? {}) as ResolveContextHints,
              );
              return 'context' in resolved ? resolved.context : resolved;
            },
          });

          const req = request(kind, MEMBER, payloadFor(kind, MEMBER));
          const scoped = executor.scoped({ targetRoleIds: [MEMBER_ROLE] });
          const checked = await scoped.precheck?.(req);
          const executed = await scoped.execute(req);

          return (
            calls.length === 0 &&
            checked?.code === 'target_is_administrator' &&
            executed.status === 'failed_precheck' &&
            executed.failure?.code === 'target_is_administrator'
          );
        },
      ),
      { numRuns: 150 },
    );
  });
});

function memoryDedupe(): DedupeStore {
  const claimed = new Set<string>();
  return {
    claim: async (key) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release: async (key) => {
      claimed.delete(key);
    },
    has: async (key) => claimed.has(key),
  };
}

describe('a role given or taken', () => {
  test('is refused by name when it sits at or above Proton, before the member is judged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ActionKind>('add_role', 'remove_role'),
        shape,
        target,
        async (kind, s, who) => {
          const id = TARGET_IDS[who];
          const { result } = await resolve(s, request(kind, id, payloadFor(kind, id)));
          const failure = refusal(result);

          const roleAbove = s.subjectPosition >= s.botPosition;
          const expected = !botHolds(s, Permissions.ManageRoles)
            ? 'missing_permission'
            : roleAbove
              ? 'role_hierarchy'
              : who === 'bot'
                ? 'target_is_self'
                : who === 'owner'
                  ? 'target_is_owner'
                  : s.memberPosition >= s.botPosition
                    ? 'role_hierarchy'
                    : null;

          if ((failure?.code ?? null) !== expected) return false;
          if (expected !== 'role_hierarchy') return true;

          return failure?.humanReason.includes(`<@&${SUBJECT_ROLE}>`) === roleAbove;
        },
      ),
      { numRuns: 500 },
    );
  });

  test('that Proton has never seen goes on to Discord, judged only on the permission and the member', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ActionKind>('add_role', 'remove_role'),
        shape,
        target,
        async (kind, s, who) => {
          const id = TARGET_IDS[who];
          const unseen = await resolve(s, request(kind, id, payloadFor(kind, id, UNCACHED_ROLE)));
          const lowest = await resolve(
            { ...s, subjectPosition: -1 },
            request(kind, id, payloadFor(kind, id, SUBJECT_ROLE)),
          );

          return (
            'context' in unseen.result &&
            unseen.result.context.role === undefined &&
            Bun.deepEquals(refusal(unseen.result), refusal(lowest.result))
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  test('is ranked only for the kinds that give, take or delete a role, never for an overwrite naming one', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ACTION_KINDS), shape, async (kind, s) => {
        const { result } = await resolve(
          s,
          request(kind, MEMBER, {
            userId: MEMBER,
            roleId: SUBJECT_ROLE,
            channelId: '500000000000000001',
          }),
        );
        if (!('context' in result)) return true;

        const ranked = kind === 'add_role' || kind === 'remove_role' || kind === 'delete_role';
        return (result.context.role?.id === SUBJECT_ROLE) === ranked;
      }),
      { numRuns: 400 },
    );
  });

  test('that Proton cannot manage is refused without looking the member up, as it is when their roles are known', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ActionKind>('add_role', 'remove_role'),
        shape,
        target,
        fc.constantFrom<MemberRolesLookup>([MEMBER_ROLE], 'not_member', null),
        async (kind, s, who, lookup) => {
          const id = TARGET_IDS[who];
          const req = request(kind, id, payloadFor(kind, id));
          const unhinted = await resolve(s, req, {}, lookup);

          if (s.subjectPosition < s.botPosition) return unhinted.lookups === 1;

          const failure = refusal(unhinted.result);
          const known = refusal((await resolve(s, req)).result);
          return (
            unhinted.lookups === 0 &&
            (failure?.code === 'missing_permission' || failure?.code === 'role_hierarchy') &&
            Bun.deepEquals(failure, known)
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});

const grant = fc.record({
  bits: KNOWN_BITS,
  withinProton: fc.boolean(),
  unknownBits: fc.bigInt({ min: 0n, max: (1n << 10n) - 1n }).map((bits) => bits << 53n),
});

describe('a role created with permissions', () => {
  test('asks Proton to hold Manage Roles and every known bit the role would grant', () => {
    fc.assert(
      fc.property(grant, (g) => {
        const permissions = g.bits | g.unknownBits;
        const required = requiredPermissionsFor('create_role', {
          name: 'Restored',
          permissions: permissions.toString(),
        });

        return required === (Permissions.ManageRoles | (permissions & ALL_PERMISSIONS));
      }),
      { numRuns: 400 },
    );
  });

  test('passes exactly when Proton holds them, and names each one it lacks', async () => {
    await fc.assert(
      fc.asyncProperty(shape, grant, async (s, g) => {
        const known = g.withinProton ? g.bits & botBase(s) : g.bits;
        const permissions = known | g.unknownBits;

        const { result, lookups } = await resolve(
          s,
          request('create_role', undefined, {
            name: 'Restored',
            permissions: permissions.toString(),
          }),
        );
        const failure = refusal(result);
        const needed = Permissions.ManageRoles | (known & ALL_PERMISSIONS);

        if (lookups !== 0) return false;
        if (botHolds(s, needed)) return failure === null;
        if (failure?.code !== 'missing_permission') return false;

        const lacking = needed & ~botBase(s);
        return permissionLabels(lacking).every((label) => failure.humanReason.includes(label));
      }),
      {
        numRuns: 500,
        examples: [
          [
            {
              everyone: 0n,
              everyoneAdministrator: false,
              botPermissions: Permissions.ManageRoles,
              botPosition: 5,
              memberPermissions: 0n,
              memberAdministrator: false,
              memberPosition: 1,
              subjectPosition: 1,
            },
            { bits: 1n << 47n, withinProton: false, unknownBits: 0n },
          ],
        ],
      },
    );
  });

  test('without a permissions field asks for Manage Roles alone, which is all the invite asks for', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (name) => {
        const required = requiredPermissionsFor('create_role', { name });
        return (
          required === Permissions.ManageRoles && invitePermissionsFor('create_role') === required
        );
      }),
      { numRuns: 100 },
    );
  });
});

const roleBelowProton = shape.map((s) => ({
  ...s,
  subjectPosition: Math.min(s.subjectPosition, s.botPosition - 1),
}));

describe('a member lookup that says they are not in the server', () => {
  test('refuses every ranked kind with its own code, never a context and never the generic lookup failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RANKED_KINDS),
        roleBelowProton,
        target,
        async (kind, s, who) => {
          const id = TARGET_IDS[who];
          const { result, lookups } = await resolve(
            s,
            request(kind, id, payloadFor(kind, id)),
            {},
            'not_member',
          );

          return (
            lookups === 1 && 'failure' in result && result.failure.code === 'target_not_member'
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  test('is never consulted when the caller already knows the member’s roles', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...RANKED_KINDS), shape, target, async (kind, s, who) => {
        const id = TARGET_IDS[who];
        const req = request(kind, id, payloadFor(kind, id));
        const hinted = await resolve(s, req, { targetRoleIds: [MEMBER_ROLE] }, 'not_member');
        const found = await resolve(s, req, {}, [MEMBER_ROLE]);

        return hinted.lookups === 0 && Bun.deepEquals(hinted.result, found.result);
      }),
      { numRuns: 300 },
    );
  });

  test('leaves a ban of someone known to be absent to go ahead without asking', async () => {
    const s: Shape = {
      everyone: 0n,
      everyoneAdministrator: false,
      botPermissions: Permissions.BanMembers,
      botPosition: 5,
      memberPermissions: 0n,
      memberAdministrator: false,
      memberPosition: 1,
      subjectPosition: 1,
    };

    const { result, lookups } = await resolve(
      s,
      request('ban', MEMBER, { userId: MEMBER }),
      { targetAbsent: true },
      'not_member',
    );

    expect(lookups).toBe(0);
    expect('context' in result && runPrechecks(result.context)).toBeNull();
  });
});
