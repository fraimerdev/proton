import { describe, expect, test } from 'bun:test';
import {
  type ConditionProvider,
  type ConditionResult,
  type MemberContext,
  ProviderRegistry,
} from '@proton/core';
import { z } from 'zod';
import { type Requirements, requirementsSchema } from '../src/config.ts';
import {
  describeRequirements,
  type EligibilityDeps,
  evaluateEligibility,
  MODERATION_HISTORY_REFUSAL,
  NO_PROFILE,
  requirementIssues,
  requirementSpecs,
} from '../src/eligibility.ts';

const GUILD = '900000000000000001';
const USER = '400000000000000001';
const ROLE_A = '200000000000000001';
const ROLE_B = '200000000000000002';
const BLOCKED = '200000000000000003';

const NOW = Date.UTC(2026, 8, 24, 12);
const DAY = 24 * 60 * 60 * 1000;

type Evaluate = (ctx: MemberContext, config: Record<string, unknown>) => Promise<ConditionResult>;

function provider(id: string, moduleId: string, schema: z.ZodObject, evaluate: Evaluate) {
  const built: ConditionProvider = {
    kind: 'condition',
    id,
    moduleId,
    label: id,
    description: id,
    configSchema: schema,
    builder: [],
    cost: 'facts',
    evaluate,
    describe: () => `describe ${id}`,
    describeFailure: () => `You have 3 bans on record in ${id}.`,
  };
  return built;
}

const levelSchema = z.object({ min: z.number().int().min(0) });
const activeSchema = z.object({ types: z.array(z.string()).min(1) });
const recentSchema = z.object({ days: z.number().int().min(1), types: z.array(z.string()).min(1) });

interface Setup {
  level?: Evaluate | null;
  active?: Evaluate | null;
  recent?: Evaluate | null;
  enabled?: Record<string, boolean | 'throw'>;
}

function levelOf(level: number): Evaluate {
  return async (_ctx, config) => ({ passed: level >= Number(config.min) });
}

const clean: Evaluate = async () => ({ passed: true });

function setup(options: Setup = {}): {
  deps: EligibilityDeps;
  asked: [string, string][];
  evaluated: string[];
} {
  const registry = new ProviderRegistry();
  const evaluated: string[] = [];
  const asked: [string, string][] = [];

  const spy =
    (id: string, inner: Evaluate): Evaluate =>
    async (ctx, config) => {
      evaluated.push(id);
      return inner(ctx, config);
    };

  const level = options.level === undefined ? levelOf(10) : options.level;
  if (level !== null) {
    registry.register({
      id: 'leveling',
      providers: [
        provider('leveling.level', 'leveling', levelSchema, spy('leveling.level', level)),
      ],
    });
  }

  const active = options.active === undefined ? clean : options.active;
  const recent = options.recent === undefined ? clean : options.recent;
  const cases = [
    ...(active === null
      ? []
      : [
          provider(
            'cases.no_active_case',
            'cases',
            activeSchema,
            spy('cases.no_active_case', active),
          ),
        ]),
    ...(recent === null
      ? []
      : [provider('cases.no_cases_in', 'cases', recentSchema, spy('cases.no_cases_in', recent))]),
  ];
  if (cases.length > 0) registry.register({ id: 'cases', providers: cases });

  const enabled = options.enabled ?? { leveling: true, cases: true };

  return {
    asked,
    evaluated,
    deps: {
      providers: registry,
      isEnabled: async (guildId, moduleId) => {
        asked.push([guildId, moduleId]);
        const state = enabled[moduleId];
        if (state === 'throw') throw new Error('config store down');
        return state === true;
      },
    },
  };
}

function member(
  overrides: {
    roleIds?: string[] | null;
    joinedAt?: Date | null;
    createdAt?: Date;
    loaded?: boolean;
  } = {},
): MemberContext {
  return {
    guildId: GUILD,
    userId: USER,
    member:
      overrides.loaded === false
        ? null
        : {
            joinedAt:
              overrides.joinedAt === undefined ? new Date(NOW - 100 * DAY) : overrides.joinedAt,
            roleIds: overrides.roleIds === undefined ? [ROLE_A] : overrides.roleIds,
            premiumSince: null,
            communicationDisabledUntil: null,
          },
    user: {
      createdAt: overrides.createdAt ?? new Date(NOW - 400 * DAY),
      hasAvatar: true,
      bot: false,
    },
    tier: 'free',
    now: new Date(NOW),
  };
}

function requirements(input: z.input<typeof requirementsSchema>): Requirements {
  return requirementsSchema.parse(input);
}

describe('requirementSpecs', () => {
  test('requirements that are off produce no checks', () => {
    expect(requirementSpecs(requirements({}))).toEqual([]);
  });

  test('each requirement maps onto the provider that owns it', () => {
    const specs = requirementSpecs(
      requirements({
        roleIds: [ROLE_A, ROLE_B],
        roleMode: 'all',
        blockedRoleIds: [BLOCKED],
        accountAgeDays: 30,
        memberAgeDays: 7,
        minLevel: 5,
        noActiveCase: true,
        noRecentCasesDays: 90,
      }),
    );

    expect(specs).toEqual([
      {
        id: 'roles',
        moduleId: 'core',
        spec: { providerId: 'core.has_role', config: { roleIds: [ROLE_A, ROLE_B], mode: 'all' } },
      },
      {
        id: 'blockedRoles',
        moduleId: 'core',
        spec: { providerId: 'core.lacks_role', config: { roleIds: [BLOCKED], mode: 'any' } },
      },
      {
        id: 'accountAge',
        moduleId: 'core',
        spec: {
          providerId: 'core.account_age',
          config: { operator: 'older-than', duration: '30d' },
        },
      },
      {
        id: 'memberAge',
        moduleId: 'core',
        spec: { providerId: 'core.member_age', config: { operator: 'older-than', duration: '7d' } },
      },
      {
        id: 'level',
        moduleId: 'leveling',
        spec: { providerId: 'leveling.level', config: { min: 5 } },
      },
      {
        id: 'activeCase',
        moduleId: 'cases',
        spec: {
          providerId: 'cases.no_active_case',
          config: { types: ['ban', 'kick', 'timeout', 'warn'] },
        },
      },
      {
        id: 'recentCases',
        moduleId: 'cases',
        spec: {
          providerId: 'cases.no_cases_in',
          config: { days: 90, types: ['ban', 'kick', 'timeout', 'warn'] },
        },
      },
    ]);
  });

  test('the core checks parse against the real core provider schemas', () => {
    const registry = new ProviderRegistry();
    const specs = requirementSpecs(
      requirements({
        roleIds: [ROLE_A],
        blockedRoleIds: [BLOCKED],
        accountAgeDays: 3650,
        memberAgeDays: 1,
      }),
    );

    for (const { spec } of specs) {
      expect(registry.parseConfig(spec.providerId, spec.config)).toEqual({
        ok: true,
        config: spec.config as Record<string, unknown>,
      });
    }
  });
});

describe('describeRequirements', () => {
  test('lines name roles as mentions and are not judged yet', () => {
    expect(
      describeRequirements(
        requirements({
          roleIds: [ROLE_A],
          blockedRoleIds: [BLOCKED, ROLE_B],
          accountAgeDays: 1,
          memberAgeDays: 14,
          minLevel: 3,
          noActiveCase: true,
          noRecentCasesDays: 30,
        }),
      ),
    ).toEqual([
      { id: 'roles', text: `Have the <@&${ROLE_A}> role.`, passed: null },
      {
        id: 'blockedRoles',
        text: `Don’t have any of these roles: <@&${BLOCKED}>, <@&${ROLE_B}>.`,
        passed: null,
      },
      { id: 'accountAge', text: 'Have a Discord account older than 1 day.', passed: null },
      { id: 'memberAge', text: 'Have been in this server for more than 14 days.', passed: null },
      { id: 'level', text: 'Be level 3 or higher.', passed: null },
      { id: 'activeCase', text: 'Have no active moderation action in this server.', passed: null },
      {
        id: 'recentCases',
        text: 'Have no moderation actions in this server in the last 30 days.',
        passed: null,
      },
    ]);
  });

  test('role wording follows the any or all choice', () => {
    const [any] = describeRequirements(requirements({ roleIds: [ROLE_A, ROLE_B] }));
    const [all] = describeRequirements(
      requirements({ roleIds: [ROLE_A, ROLE_B], roleMode: 'all' }),
    );

    expect(any?.text).toBe(`Have one of these roles: <@&${ROLE_A}>, <@&${ROLE_B}>.`);
    expect(all?.text).toBe(`Have all of these roles: <@&${ROLE_A}>, <@&${ROLE_B}>.`);
  });
});

describe('evaluateEligibility', () => {
  test('a form with no requirements is open to everyone and needs no member facts', async () => {
    const { deps, asked } = setup();

    expect(await evaluateEligibility(deps, member(), requirements({}))).toEqual({
      state: 'eligible',
      lines: [],
    });
    expect(await evaluateEligibility(deps, null, requirements({}))).toEqual({
      state: 'eligible',
      lines: [],
    });
    expect(asked).toEqual([]);
  });

  test('core requirements pass and fail on the member facts', async () => {
    const { deps } = setup();
    const needs = requirements({ roleIds: [ROLE_A, ROLE_B], accountAgeDays: 30 });

    expect(await evaluateEligibility(deps, member(), needs)).toEqual({
      state: 'eligible',
      lines: [
        {
          id: 'roles',
          text: `Have one of these roles: <@&${ROLE_A}>, <@&${ROLE_B}>.`,
          passed: true,
        },
        { id: 'accountAge', text: 'Have a Discord account older than 30 days.', passed: true },
      ],
    });

    const young = await evaluateEligibility(
      deps,
      member({ roleIds: [], createdAt: new Date(NOW - 2 * DAY) }),
      needs,
    );
    expect(young.state).toBe('ineligible');
    expect(young.lines.map((line) => line.passed)).toEqual([false, false]);
  });

  test('all-roles mode needs every role, and a blocked role shuts the form', async () => {
    const { deps } = setup();

    const all = await evaluateEligibility(
      deps,
      member({ roleIds: [ROLE_A] }),
      requirements({ roleIds: [ROLE_A, ROLE_B], roleMode: 'all' }),
    );
    expect(all.state).toBe('ineligible');

    const blocked = await evaluateEligibility(
      deps,
      member({ roleIds: [ROLE_A, BLOCKED] }),
      requirements({ blockedRoleIds: [BLOCKED] }),
    );
    expect(blocked).toEqual({
      state: 'ineligible',
      lines: [{ id: 'blockedRoles', text: `Don’t have the <@&${BLOCKED}> role.`, passed: false }],
    });
  });

  test('no member facts at all blocks every requirement instead of passing it', async () => {
    const { deps, evaluated } = setup();
    const result = await evaluateEligibility(
      deps,
      null,
      requirements({ roleIds: [ROLE_A], minLevel: 2 }),
    );

    expect(result).toEqual({
      state: 'blocked',
      lines: [
        { id: 'roles', text: `Have the <@&${ROLE_A}> role.`, passed: null },
        { id: 'level', text: 'Be level 2 or higher.', passed: null },
      ],
      issues: [
        { id: 'roles', humanReason: NO_PROFILE },
        { id: 'level', humanReason: NO_PROFILE },
      ],
    });
    expect(evaluated).toEqual([]);
  });

  test('a member whose roles could not be loaded is blocked, not judged as holding none', async () => {
    const { deps } = setup();

    for (const facts of [member({ loaded: false }), member({ roleIds: null })]) {
      const result = await evaluateEligibility(
        deps,
        facts,
        requirements({ blockedRoleIds: [BLOCKED] }),
      );
      expect(result.state).toBe('blocked');
      expect(result.lines[0]?.passed).toBeNull();
    }
  });

  test('an unknown join date blocks the server-age requirement', async () => {
    const { deps } = setup();
    const result = await evaluateEligibility(
      deps,
      member({ joinedAt: null }),
      requirements({ memberAgeDays: 7 }),
    );

    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.issues.map((issue) => issue.id)).toEqual(['memberAge']);
  });

  test('Leveling switched off blocks the level requirement with a staff-facing reason', async () => {
    const { deps, asked, evaluated } = setup({ enabled: { leveling: false, cases: true } });
    const result = await evaluateEligibility(deps, member(), requirements({ minLevel: 5 }));

    expect(result).toEqual({
      state: 'blocked',
      lines: [{ id: 'level', text: 'Be level 5 or higher.', passed: null }],
      issues: [
        { id: 'level', humanReason: 'Minimum level needs Leveling, which is off in this server.' },
      ],
    });
    expect(asked).toEqual([[GUILD, 'leveling']]);
    expect(evaluated).toEqual([]);
  });

  test('Cases switched off blocks both moderation requirements', async () => {
    const { deps } = setup({ enabled: { leveling: true, cases: false } });
    const result = await evaluateEligibility(
      deps,
      member(),
      requirements({ noActiveCase: true, noRecentCasesDays: 30 }),
    );

    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.issues).toEqual([
      {
        id: 'activeCase',
        humanReason: 'No active moderation needs Cases, which is off in this server.',
      },
      {
        id: 'recentCases',
        humanReason: 'No recent moderation needs Cases, which is off in this server.',
      },
    ]);
  });

  test('when the module switch cannot be read, the requirement is blocked', async () => {
    const { deps } = setup({ enabled: { leveling: 'throw', cases: true } });
    const result = await evaluateEligibility(deps, member(), requirements({ minLevel: 5 }));

    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.issues).toEqual([
      {
        id: 'level',
        humanReason: 'Minimum level couldn’t be checked just now. Try again in a moment.',
      },
    ]);
  });

  test('a provider this process never loaded blocks the requirement', async () => {
    const { deps } = setup({ level: null });
    const result = await evaluateEligibility(deps, member(), requirements({ minLevel: 5 }));

    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.issues).toEqual([
      {
        id: 'level',
        humanReason: 'Minimum level needs Leveling, which Proton can’t reach right now.',
      },
    ]);
  });

  test('a provider that throws or answers nothing blocks the requirement', async () => {
    const broken: Evaluate[] = [
      async () => {
        throw new Error('database down');
      },
      async () => undefined as unknown as ConditionResult,
      async () => null as unknown as ConditionResult,
    ];

    for (const level of broken) {
      const { deps } = setup({ level });
      const result = await evaluateEligibility(deps, member(), requirements({ minLevel: 5 }));
      expect(result).toEqual({
        state: 'blocked',
        lines: [{ id: 'level', text: 'Be level 5 or higher.', passed: null }],
        issues: [
          {
            id: 'level',
            humanReason: 'Minimum level couldn’t be checked just now. Try again in a moment.',
          },
        ],
      });
    }
  });

  test('an indeterminate answer blocks with the provider’s own reason, even when it says passed', async () => {
    for (const passed of [false, true]) {
      const { deps } = setup({
        active: async () => ({
          passed,
          indeterminate: { humanReason: 'Case history is loading.' },
        }),
      });
      const result = await evaluateEligibility(
        deps,
        member(),
        requirements({ noActiveCase: true }),
      );

      expect(result.state).toBe('blocked');
      if (result.state !== 'blocked') continue;
      expect(result.issues).toEqual([
        { id: 'activeCase', humanReason: 'Case history is loading.' },
      ]);
    }
  });

  test('settings the provider refuses block the requirement', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'cases',
      providers: [
        provider(
          'cases.no_active_case',
          'cases',
          z.object({ types: z.array(z.enum(['ban'])).min(1) }),
          clean,
        ),
      ],
    });

    const result = await evaluateEligibility(
      { providers: registry, isEnabled: async () => true },
      member(),
      requirements({ noActiveCase: true }),
    );

    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.issues[0]?.id).toBe('activeCase');
    expect(result.issues[0]?.humanReason).toContain("aren't valid");
  });

  test('a moderation history that fails reads the same neutral line whatever the detail', async () => {
    const { deps } = setup({
      active: async () => ({ passed: false }),
      recent: async () => ({ passed: false, progress: { current: 3, required: 0, unit: 'cases' } }),
    });
    const result = await evaluateEligibility(
      deps,
      member(),
      requirements({ noActiveCase: true, noRecentCasesDays: 30 }),
    );

    expect(result).toEqual({
      state: 'ineligible',
      lines: [
        { id: 'activeCase', text: MODERATION_HISTORY_REFUSAL, passed: false },
        { id: 'recentCases', text: MODERATION_HISTORY_REFUSAL, passed: false },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('bans');
  });

  test('level is judged by the Leveling provider', async () => {
    const needs = requirements({ minLevel: 5 });
    const at = async (level: number) =>
      (await evaluateEligibility(setup({ level: levelOf(level) }).deps, member(), needs)).state;

    expect(await at(5)).toBe('eligible');
    expect(await at(4)).toBe('ineligible');
  });

  test('a blocked requirement outranks a failed one', async () => {
    const { deps } = setup({ enabled: { leveling: false, cases: true } });
    const result = await evaluateEligibility(
      deps,
      member({ roleIds: [] }),
      requirements({ roleIds: [ROLE_A], minLevel: 5 }),
    );

    expect(result.state).toBe('blocked');
    expect(result.lines.map((line) => line.passed)).toEqual([false, null]);
  });

  test('no way of failing to check ever comes out eligible', async () => {
    const needs = requirements({ roleIds: [ROLE_A], minLevel: 1, noActiveCase: true });
    const scenarios: [string, EligibilityDeps, MemberContext | null][] = [
      ['no member', setup().deps, null],
      ['member not loadable', setup().deps, member({ loaded: false })],
      ['leveling off', setup({ enabled: { leveling: false, cases: true } }).deps, member()],
      ['cases off', setup({ enabled: { leveling: true, cases: false } }).deps, member()],
      ['switch unreadable', setup({ enabled: { leveling: true, cases: 'throw' } }).deps, member()],
      ['leveling missing', setup({ level: null }).deps, member()],
      ['cases missing', setup({ active: null }).deps, member()],
      [
        'provider throws',
        setup({
          active: async () => {
            throw new Error('x');
          },
        }).deps,
        member(),
      ],
      [
        'indeterminate',
        setup({ level: async () => ({ passed: true, indeterminate: { humanReason: 'x' } }) }).deps,
        member(),
      ],
    ];

    for (const [name, deps, facts] of scenarios) {
      const result = await evaluateEligibility(deps, facts, needs);
      expect([name, result.state]).toEqual([name, 'blocked']);
    }
  });
});

describe('requirementIssues', () => {
  const needs = requirements({
    roleIds: [ROLE_A],
    minLevel: 5,
    noActiveCase: true,
    noRecentCasesDays: 30,
  });

  test('a requirement whose module is off is a configuration issue', () => {
    expect(requirementIssues(needs, { leveling: false, cases: true })).toEqual([
      {
        id: 'level',
        humanReason:
          'Minimum level needs Leveling, which is off in this server. Turn Leveling on, or remove this requirement.',
      },
    ]);
    expect(requirementIssues(needs, {}).map((issue) => issue.id)).toEqual([
      'level',
      'activeCase',
      'recentCases',
    ]);
    expect(requirementIssues(needs, { leveling: true, cases: true })).toEqual([]);
  });

  test('core requirements never need a module', () => {
    const core = requirements({ roleIds: [ROLE_A], accountAgeDays: 5 });
    expect(requirementIssues(core, {})).toEqual([]);
  });

  test('a role both required and blocked is flagged', () => {
    expect(
      requirementIssues(requirements({ roleIds: [ROLE_A], blockedRoleIds: [ROLE_A, BLOCKED] }), {}),
    ).toEqual([
      {
        id: 'blockedRoles',
        humanReason: `A role can’t be both required and blocked: <@&${ROLE_A}>.`,
      },
    ]);
  });

  test('no issue or line carries an em dash', () => {
    const everything = requirements({
      roleIds: [ROLE_A],
      blockedRoleIds: [ROLE_A],
      accountAgeDays: 2,
      memberAgeDays: 2,
      minLevel: 2,
      noActiveCase: true,
      noRecentCasesDays: 2,
    });
    const text = JSON.stringify([
      requirementIssues(everything, {}),
      describeRequirements(everything),
    ]);
    expect(text).not.toContain('—');
  });
});
