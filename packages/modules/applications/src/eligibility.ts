import type {
  ConditionResult,
  MemberContext,
  ProviderRegistry,
  RequirementSpec,
} from '@proton/core';
import { z } from 'zod';
import type { Requirements } from './config.ts';
import { dayCount } from './web.ts';

export const REQUIREMENT_IDS = [
  'roles',
  'blockedRoles',
  'accountAge',
  'memberAge',
  'level',
  'activeCase',
  'recentCases',
] as const;
export type RequirementId = (typeof REQUIREMENT_IDS)[number];

export const REQUIREMENT_MODULES = ['core', 'leveling', 'cases'] as const;
export type RequirementModule = (typeof REQUIREMENT_MODULES)[number];

export const CASE_TYPES_COUNTED = ['ban', 'kick', 'timeout', 'warn'] as const;

export const requirementLineSchema = z.object({
  id: z.enum(REQUIREMENT_IDS),
  text: z.string(),
  passed: z.boolean().nullable(),
});
export type RequirementLine = z.infer<typeof requirementLineSchema>;

export const requirementIssueSchema = z.object({
  id: z.enum(REQUIREMENT_IDS),
  humanReason: z.string(),
});
export type RequirementIssue = z.infer<typeof requirementIssueSchema>;

export const eligibilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('eligible'), lines: z.array(requirementLineSchema) }),
  z.object({ state: z.literal('ineligible'), lines: z.array(requirementLineSchema) }),
  z.object({
    state: z.literal('blocked'),
    lines: z.array(requirementLineSchema),
    issues: z.array(requirementIssueSchema),
  }),
]);
export type Eligibility = z.infer<typeof eligibilitySchema>;

export interface EligibilityDeps {
  providers: ProviderRegistry;
  isEnabled(guildId: string, moduleId: string): Promise<boolean>;
}

export interface RequirementEntry {
  id: RequirementId;
  spec: RequirementSpec;
  moduleId: RequirementModule;
}

export const REQUIREMENT_NAMES: Readonly<Record<RequirementId, string>> = {
  roles: 'The required roles',
  blockedRoles: 'The blocked roles',
  accountAge: 'Account age',
  memberAge: 'Time in this server',
  level: 'Minimum level',
  activeCase: 'No active moderation',
  recentCases: 'No recent moderation',
};

const MODULE_NAMES: Readonly<Record<RequirementModule, string>> = {
  core: 'Proton',
  leveling: 'Leveling',
  cases: 'Cases',
};

export const MODERATION_HISTORY_REFUSAL =
  'Your moderation history in this server doesn’t meet this form’s requirements.';

export const NO_PROFILE = 'Proton couldn’t check your roles right now. Try again in a moment.';

export function requirementSpecs(requirements: Requirements): RequirementEntry[] {
  const entries: RequirementEntry[] = [];

  if (requirements.roleIds.length > 0) {
    entries.push({
      id: 'roles',
      moduleId: 'core',
      spec: {
        providerId: 'core.has_role',
        config: { roleIds: [...requirements.roleIds], mode: requirements.roleMode },
      },
    });
  }

  if (requirements.blockedRoleIds.length > 0) {
    entries.push({
      id: 'blockedRoles',
      moduleId: 'core',
      spec: {
        providerId: 'core.lacks_role',
        config: { roleIds: [...requirements.blockedRoleIds], mode: 'any' },
      },
    });
  }

  if (requirements.accountAgeDays > 0) {
    entries.push({
      id: 'accountAge',
      moduleId: 'core',
      spec: {
        providerId: 'core.account_age',
        config: { operator: 'older-than', duration: `${requirements.accountAgeDays}d` },
      },
    });
  }

  if (requirements.memberAgeDays > 0) {
    entries.push({
      id: 'memberAge',
      moduleId: 'core',
      spec: {
        providerId: 'core.member_age',
        config: { operator: 'older-than', duration: `${requirements.memberAgeDays}d` },
      },
    });
  }

  if (requirements.minLevel > 0) {
    entries.push({
      id: 'level',
      moduleId: 'leveling',
      spec: { providerId: 'leveling.level', config: { min: requirements.minLevel } },
    });
  }

  if (requirements.noActiveCase) {
    entries.push({
      id: 'activeCase',
      moduleId: 'cases',
      spec: { providerId: 'cases.no_active_case', config: { types: [...CASE_TYPES_COUNTED] } },
    });
  }

  if (requirements.noRecentCasesDays > 0) {
    entries.push({
      id: 'recentCases',
      moduleId: 'cases',
      spec: {
        providerId: 'cases.no_cases_in',
        config: { days: requirements.noRecentCasesDays, types: [...CASE_TYPES_COUNTED] },
      },
    });
  }

  return entries;
}

function roleList(roleIds: readonly string[]): string {
  return roleIds.map((id) => `<@&${id}>`).join(', ');
}

function describe(id: RequirementId, requirements: Requirements): string {
  const { roleIds, blockedRoleIds } = requirements;

  switch (id) {
    case 'roles':
      if (roleIds.length === 1) return `Have the ${roleList(roleIds)} role.`;
      return requirements.roleMode === 'all'
        ? `Have all of these roles: ${roleList(roleIds)}.`
        : `Have one of these roles: ${roleList(roleIds)}.`;
    case 'blockedRoles':
      return blockedRoleIds.length === 1
        ? `Don’t have the ${roleList(blockedRoleIds)} role.`
        : `Don’t have any of these roles: ${roleList(blockedRoleIds)}.`;
    case 'accountAge':
      return `Have a Discord account older than ${dayCount(requirements.accountAgeDays)}.`;
    case 'memberAge':
      return `Have been in this server for more than ${dayCount(requirements.memberAgeDays)}.`;
    case 'level':
      return `Be level ${requirements.minLevel} or higher.`;
    case 'activeCase':
      return 'Have no active moderation action in this server.';
    case 'recentCases':
      return `Have no moderation actions in this server in the last ${dayCount(requirements.noRecentCasesDays)}.`;
  }
}

export function describeRequirements(requirements: Requirements): RequirementLine[] {
  return requirementSpecs(requirements).map(({ id }) => ({
    id,
    text: describe(id, requirements),
    passed: null,
  }));
}

function moduleOff(entry: RequirementEntry): string {
  return `${REQUIREMENT_NAMES[entry.id]} needs ${MODULE_NAMES[entry.moduleId]}, which is off in this server.`;
}

function unavailable(entry: RequirementEntry): string {
  return entry.moduleId === 'core'
    ? `${REQUIREMENT_NAMES[entry.id]} can’t be checked right now.`
    : `${REQUIREMENT_NAMES[entry.id]} needs ${MODULE_NAMES[entry.moduleId]}, which Proton can’t reach right now.`;
}

function unchecked(entry: RequirementEntry): string {
  return `${REQUIREMENT_NAMES[entry.id]} couldn’t be checked just now. Try again in a moment.`;
}

type Outcome = { kind: 'passed' } | { kind: 'failed' } | { kind: 'blocked'; humanReason: string };

async function moduleIsOn(
  deps: EligibilityDeps,
  guildId: string,
  entry: RequirementEntry,
): Promise<boolean | null> {
  if (entry.moduleId === 'core') return true;

  try {
    return (await deps.isEnabled(guildId, entry.moduleId)) === true;
  } catch {
    return null;
  }
}

async function judge(
  deps: EligibilityDeps,
  member: MemberContext,
  entry: RequirementEntry,
): Promise<Outcome> {
  const on = await moduleIsOn(deps, member.guildId, entry);
  if (on === null) return { kind: 'blocked', humanReason: unchecked(entry) };
  if (!on) return { kind: 'blocked', humanReason: moduleOff(entry) };

  const provider = deps.providers.condition(entry.spec.providerId);
  if (provider === undefined) return { kind: 'blocked', humanReason: unavailable(entry) };

  const parsed = deps.providers.parseConfig(entry.spec.providerId, entry.spec.config);
  if (!parsed.ok) return { kind: 'blocked', humanReason: parsed.humanReason };

  let result: ConditionResult | undefined;
  try {
    result = await provider.evaluate(member, parsed.config);
  } catch {
    result = undefined;
  }

  if (typeof result !== 'object' || result === null) {
    return { kind: 'blocked', humanReason: unchecked(entry) };
  }

  if (result.indeterminate !== undefined) {
    return { kind: 'blocked', humanReason: result.indeterminate.humanReason };
  }

  return result.passed === true ? { kind: 'passed' } : { kind: 'failed' };
}

export async function evaluateEligibility(
  deps: EligibilityDeps,
  member: MemberContext | null,
  requirements: Requirements,
): Promise<Eligibility> {
  const entries = requirementSpecs(requirements);
  const lines = describeRequirements(requirements);

  if (entries.length === 0) return { state: 'eligible', lines };

  if (member === null) {
    return {
      state: 'blocked',
      lines,
      issues: entries.map(({ id }) => ({ id, humanReason: NO_PROFILE })),
    };
  }

  const outcomes = await Promise.all(entries.map((entry) => judge(deps, member, entry)));
  const issues: RequirementIssue[] = [];

  const judged = lines.map((line, index): RequirementLine => {
    const outcome = outcomes[index];
    const entry = entries[index];

    if (outcome === undefined || entry === undefined) return line;

    if (outcome.kind === 'blocked') {
      issues.push({ id: line.id, humanReason: outcome.humanReason });
      return line;
    }

    if (outcome.kind === 'passed') return { ...line, passed: true };

    return entry.moduleId === 'cases'
      ? { ...line, text: MODERATION_HISTORY_REFUSAL, passed: false }
      : { ...line, passed: false };
  });

  if (issues.length > 0) return { state: 'blocked', lines: judged, issues };
  if (judged.some((line) => line.passed === false)) return { state: 'ineligible', lines: judged };
  return { state: 'eligible', lines: judged };
}

export function requirementIssues(
  requirements: Requirements,
  modulesOn: Readonly<Record<string, boolean>>,
): RequirementIssue[] {
  const issues: RequirementIssue[] = [];
  const on = (moduleId: string) =>
    Object.hasOwn(modulesOn, moduleId) && modulesOn[moduleId] === true;

  for (const entry of requirementSpecs(requirements)) {
    if (entry.moduleId === 'core' || on(entry.moduleId)) continue;

    issues.push({
      id: entry.id,
      humanReason:
        `${moduleOff(entry)} Turn ${MODULE_NAMES[entry.moduleId]} on, or remove this ` +
        'requirement.',
    });
  }

  const required = new Set(requirements.roleIds);
  const both = requirements.blockedRoleIds.filter((roleId) => required.has(roleId));
  if (both.length > 0) {
    issues.push({
      id: 'blockedRoles',
      humanReason: `A role can’t be both required and blocked: ${roleList(both)}.`,
    });
  }

  return issues;
}
