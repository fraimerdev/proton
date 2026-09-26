import {
  type CommandContext,
  computeBasePermissions,
  createdAtOf,
  type EntitlementTier,
  type GuildState,
  type MemberContext,
  memberContextFromGuildMember,
  type ProtonEvent,
} from '@proton/core';
import type { ReviewActor } from './authorize.ts';
import type { Requirements } from './config.ts';
import type { BoundApplicationsDeps, MemberLookup } from './deps.ts';
import {
  describeRequirements,
  type Eligibility,
  type EligibilityDeps,
  evaluateEligibility,
  requirementSpecs,
} from './eligibility.ts';

const NOT_CHECKABLE = 'I can’t check this requirement right now. Try again later.';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function memberContextOf(
  event: ProtonEvent,
  guildId: string,
  now: number,
  tier: EntitlementTier,
): MemberContext | null {
  const member = record(event.payload)?.member;
  return memberContextFromGuildMember(guildId, member, new Date(now), tier);
}

export function commandMemberContext(
  ctx: Pick<
    CommandContext,
    'guildId' | 'userId' | 'actorRoleIds' | 'actorJoinedAt' | 'actorNick' | 'tier'
  >,
  now: number,
): MemberContext | null {
  const createdAt = createdAtOf(ctx.userId);
  if (createdAt === null) return null;

  const joinedAt = ctx.actorJoinedAt ?? null;

  return {
    guildId: ctx.guildId,
    userId: ctx.userId,
    member:
      ctx.actorRoleIds === undefined
        ? null
        : {
            joinedAt: joinedAt === null ? null : new Date(joinedAt),
            roleIds: [...ctx.actorRoleIds],
            premiumSince: null,
            communicationDisabledUntil: null,
            nickname: ctx.actorNick ?? null,
          },
    user: { createdAt, hasAvatar: null, bot: false },
    tier: ctx.tier ?? 'free',
    now: new Date(now),
  };
}

async function guildStateOf(
  deps: Pick<BoundApplicationsDeps, 'guildState'>,
  guildId: string,
): Promise<GuildState | null> {
  try {
    return (await deps.guildState?.get(guildId)) ?? null;
  } catch {
    return null;
  }
}

export async function reviewActorFor(
  deps: Pick<BoundApplicationsDeps, 'lookupMember' | 'guildState'>,
  guildId: string,
  userId: string,
): Promise<ReviewActor | null> {
  if (deps.lookupMember === null) return null;

  let found: Awaited<ReturnType<MemberLookup>>;
  try {
    found = await deps.lookupMember(guildId, userId);
  } catch {
    return null;
  }
  if (found.state !== 'member') return null;

  const state = await guildStateOf(deps, guildId);
  if (state === null) return { id: userId, roleIds: found.roleIds, permissions: 0n, owner: false };

  return {
    id: userId,
    roleIds: found.roleIds,
    permissions: computeBasePermissions({
      guildOwnerId: state.ownerId,
      everyoneRoleId: state.everyoneRoleId,
      memberId: userId,
      memberRoleIds: found.roleIds,
      roles: state.roles,
    }),
    owner: state.ownerId === userId,
  };
}

export function applicantNameOf(event: ProtonEvent): string | null {
  const payload = record(event.payload);
  const member = record(payload?.member);
  const user = record(member?.user) ?? record(payload?.user);

  const name = text(member?.nick) ?? text(user?.global_name) ?? text(user?.username);
  return name === null ? null : name.slice(0, 100);
}

export function eligibilityDepsOf(deps: BoundApplicationsDeps): EligibilityDeps | null {
  const { providers, availability } = deps;
  if (providers === null) return null;

  return {
    providers,
    isEnabled: async (guildId, moduleId) => {
      if (availability === null) {
        throw new Error('the applications module was built without a module availability port');
      }
      return availability.isEnabled(guildId, moduleId);
    },
  };
}

export async function eligibilityFor(
  deps: BoundApplicationsDeps,
  member: MemberContext | null,
  requirements: Requirements,
): Promise<Eligibility> {
  const checker = eligibilityDepsOf(deps);
  if (checker !== null) return evaluateEligibility(checker, member, requirements);

  const specs = requirementSpecs(requirements);
  const lines = describeRequirements(requirements);
  if (specs.length === 0) return { state: 'eligible', lines };

  return {
    state: 'blocked',
    lines,
    issues: specs.map(({ id }) => ({ id, humanReason: NOT_CHECKABLE })),
  };
}
