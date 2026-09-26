import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { ACTION_KINDS, type ActionKind, hierarchyApplies } from '../../src/actions/kinds.ts';
import { runPrechecks } from '../../src/actions/prechecks.ts';
import {
  type ResolveContextHints,
  type ResolveContextResult,
  resolvePrecheckContext,
} from '../../src/actions/resolve-context.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type { GuildState, GuildStateStore } from '../../src/guild-state/types.ts';
import { has, Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const MEMBER = '100000000000000001';
const CHANNEL = '500000000000000001';
const BOT_ROLE = '410000000000000005';
const MEMBER_ROLE = '410000000000000001';
const HIGH_ROLE = '410000000000000009';

const HIGH_POSITION = 40;

const permissionBits = fc.bigInt({ min: 0n, max: (1n << 53n) - 1n });

type Target = 'owner' | 'bot' | 'member';
const TARGET_IDS: Record<Target, string> = { owner: OWNER, bot: BOT, member: MEMBER };
const target = fc.constantFrom<Target>('owner', 'bot', 'member');

const RANKED_KINDS = ACTION_KINDS.filter(hierarchyApplies);
const MEMBER_ROLE_SETS: string[][] = [[], [MEMBER_ROLE], [HIGH_ROLE], [MEMBER_ROLE, HIGH_ROLE]];

const roleSet = fc.constantFrom(...MEMBER_ROLE_SETS);

const hintsWithoutAbsence = fc.record({
  channelId: fc.option(fc.constant(CHANNEL), { nil: undefined }),
  appPermissions: fc.option(permissionBits, { nil: undefined }),
  targetRoleIds: fc.option(roleSet, { nil: undefined }),
  targetAbsent: fc.constantFrom<false | undefined>(false, undefined),
});

const guildShape = fc.record({
  botPermissions: permissionBits,
  botPosition: fc.integer({ min: 0, max: 60 }),
  memberPosition: fc.integer({ min: 0, max: 60 }),
});

type GuildShape = { botPermissions: bigint; botPosition: number; memberPosition: number };

function guild(shape: GuildShape): GuildStateStore {
  const state: GuildState = {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: shape.botPermissions, position: shape.botPosition }],
      [MEMBER_ROLE, { id: MEMBER_ROLE, permissions: 0n, position: shape.memberPosition }],
      [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: HIGH_POSITION }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };

  return {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

function request(kind: ActionKind, targetId: string, payload?: unknown): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind,
    targetId,
    actorId: '100000000000000077',
    dryRun: false,
    idempotencyKey: 'k',
    payload: payload ?? { userId: targetId },
  };
}

async function resolve(
  shape: GuildShape,
  req: ActionRequest,
  hints: ResolveContextHints,
  fetched: string[] | null,
): Promise<{ result: ResolveContextResult; lookups: number }> {
  let lookups = 0;
  const result = await resolvePrecheckContext(
    {
      store: guild(shape),
      botUserId: BOT,
      fetchMemberRoles: async () => {
        lookups += 1;
        return fetched;
      },
    },
    req,
    hints,
  );
  return { result, lookups };
}

function position(shape: GuildShape, roleIds: readonly string[]): number {
  let highest = 0;
  for (const id of roleIds) {
    const at = id === MEMBER_ROLE ? shape.memberPosition : id === HIGH_ROLE ? HIGH_POSITION : 0;
    if (at > highest) highest = at;
  }
  return highest;
}

function expectedRankRefusal(
  shape: GuildShape,
  who: Target,
  roleIds: readonly string[],
): string | null {
  if (who === 'bot') return 'target_is_self';
  if (who === 'owner') return 'target_is_owner';
  return position(shape, roleIds) >= shape.botPosition ? 'role_hierarchy' : null;
}

describe('without the targetAbsent hint, nothing skips the owner or hierarchy prechecks', () => {
  test('every ranked kind is refused for the owner, for Proton and for anyone at or above it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RANKED_KINDS),
        guildShape,
        target,
        hintsWithoutAbsence,
        fc.option(roleSet, { nil: null }),
        async (kind, shape, who, hints, fetched) => {
          const administrator = { ...shape, botPermissions: Permissions.Administrator };
          const { result } = await resolve(
            administrator,
            request(kind, TARGET_IDS[who]),
            hints,
            fetched,
          );

          const known = hints.targetRoleIds ?? fetched;
          if (!known) {
            return 'failure' in result && result.failure.code === 'target_state_unavailable';
          }
          if (!('context' in result)) return false;
          if (result.context.hierarchy === false) return false;
          if (result.context.targetIsMember === false) return false;

          const failure = runPrechecks(result.context);
          return (failure?.code ?? null) === expectedRankRefusal(administrator, who, known);
        },
      ),
      { numRuns: 400 },
    );
  });

  test('an unavailable member lookup is always a refusal, never a context with checks switched off', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RANKED_KINDS),
        guildShape,
        target,
        hintsWithoutAbsence.map((hints) => ({ ...hints, targetRoleIds: undefined })),
        async (kind, shape, who, hints) => {
          const { result, lookups } = await resolve(
            shape,
            request(kind, TARGET_IDS[who]),
            hints,
            null,
          );

          return (
            lookups === 1 &&
            'failure' in result &&
            result.failure.code === 'target_state_unavailable'
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('targetAbsent changes ban and nothing else', () => {
  test('every other kind resolves exactly as it would without the hint', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ACTION_KINDS.filter((kind) => kind !== 'ban')),
        guildShape,
        target,
        hintsWithoutAbsence,
        fc.option(roleSet, { nil: null }),
        async (kind, shape, who, hints, fetched) => {
          const req = request(kind, TARGET_IDS[who], {
            userId: TARGET_IDS[who],
            channelId: CHANNEL,
          });
          const plain = await resolve(shape, req, hints, fetched);
          const hinted = await resolve(shape, req, { ...hints, targetAbsent: true }, fetched);

          return (
            Bun.deepEquals(plain.result, hinted.result) &&
            plain.lookups === hinted.lookups &&
            !('context' in hinted.result && hinted.result.context.targetIsMember === false)
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  test('a ban with it never looks the user up and is never refused for rank', async () => {
    await fc.assert(
      fc.asyncProperty(
        guildShape,
        fc.constantFrom<Target>('owner', 'member'),
        hintsWithoutAbsence,
        fc.option(roleSet, { nil: null }),
        async (shape, who, hints, fetched) => {
          const { result, lookups } = await resolve(
            shape,
            request('ban', TARGET_IDS[who]),
            { ...hints, targetAbsent: true },
            fetched,
          );
          if (!('context' in result)) return false;

          const code = runPrechecks(result.context)?.code ?? null;
          const mayBan =
            has(shape.botPermissions, Permissions.BanMembers) ||
            has(shape.botPermissions, Permissions.Administrator);

          return (
            lookups === 0 &&
            result.context.targetIsMember === false &&
            code !== 'role_hierarchy' &&
            (mayBan
              ? code === (who === 'owner' ? 'target_is_owner' : null)
              : code === 'missing_permission')
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  test('a ban with it still refuses to ban Proton itself', async () => {
    await fc.assert(
      fc.asyncProperty(guildShape, hintsWithoutAbsence, async (shape, hints) => {
        const administrator = { ...shape, botPermissions: Permissions.Administrator };
        const { result } = await resolve(
          administrator,
          request('ban', BOT),
          { ...hints, targetAbsent: true },
          null,
        );

        return 'context' in result && runPrechecks(result.context)?.code === 'target_is_self';
      }),
      { numRuns: 200 },
    );
  });
});

describe('a voice disconnect needs Move Members and nothing more', () => {
  test('passes exactly when Proton holds Move Members server-wide, whoever it disconnects', async () => {
    await fc.assert(
      fc.asyncProperty(
        guildShape,
        target,
        fc.record({
          channelId: fc.option(fc.constant(CHANNEL), { nil: undefined }),
          appPermissions: fc.option(permissionBits, { nil: undefined }),
        }),
        async (shape, who, hints) => {
          const id = TARGET_IDS[who];
          const { result, lookups } = await resolve(
            shape,
            request('move_member', id, { userId: id, channelId: null }),
            hints,
            null,
          );
          if (!('context' in result)) return false;

          const code = runPrechecks(result.context)?.code ?? null;
          const mayMove =
            has(shape.botPermissions, Permissions.MoveMembers) ||
            has(shape.botPermissions, Permissions.Administrator);

          const expected = !mayMove
            ? 'missing_permission'
            : who === 'bot'
              ? 'target_is_self'
              : null;

          return (
            lookups === 0 &&
            result.context.channelId === undefined &&
            result.context.requiredPermissions === Permissions.MoveMembers &&
            code === expected
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});
