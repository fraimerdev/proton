import { describe, expect, test } from 'bun:test';
import type { ActionExecutor, ActionRequest, ActionResult } from '../../src/actions/types.ts';
import type { ProtonEvent } from '../../src/events/types.ts';
import type { MemberContextLoader } from '../../src/providers/member-context.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import type { MemberContext } from '../../src/providers/types.ts';
import { RuleEngine } from '../../src/rules/engine.ts';
import type { RateWindowHit, RateWindowStore } from '../../src/rules/rate-window.ts';
import type { GuildRule } from '../../src/rules/types.ts';
import { countingCondition } from '../providers/harness.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000000';
const MEMBER = '400000000000000000';
const ROLE_A = '600000000000000000';
const ROLE_B = '600000000000000001';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

class FakeExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return { status: 'executed', caseId: 'case-1' };
  }
}

class FakeRateWindow implements RateWindowStore {
  readonly hits: RateWindowHit[] = [];

  async hit(input: RateWindowHit) {
    this.hits.push(input);
    return { count: 5, tripped: true };
  }
}

function rule(overrides: Partial<GuildRule> = {}): GuildRule {
  return {
    id: 'gate',
    guildId: GUILD,
    moduleId: 'automod',
    trigger: { kind: 'event', event: 'message.created' },
    conditions: [],
    actions: [{ kind: 'timeout', duration: '10m', reason: 'Gated' }],
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

const EVENT: ProtonEvent = {
  id: 'message.created:1234',
  type: 'message.created',
  guildId: GUILD,
  occurredAt: NOW,
  payload: {},
};

function run(
  rules: GuildRule[],
  options: {
    registry?: ProviderRegistry;
    memberContext?: MemberContextLoader;
    roleIds?: string[];
  } = {},
) {
  const executor = new FakeExecutor();
  const rateWindow = new FakeRateWindow();

  const engine = new RuleEngine({
    executor,
    rateWindow,
    now: () => NOW,
    ...(options.registry ? { providers: options.registry } : {}),
    ...(options.memberContext ? { memberContext: options.memberContext } : {}),
  });

  return {
    executor,
    rateWindow,
    report: engine.evaluate({
      event: EVENT,
      rules,
      facts: { actorId: MEMBER, channelId: CHANNEL, roleIds: options.roleIds ?? [ROLE_A] },
      dryRun: false,
    }),
  };
}

function skipReason(outcomes: Awaited<ReturnType<RuleEngine['evaluate']>>['outcomes']): string {
  return outcomes[0]?.skipped?.humanReason ?? '';
}

describe('provider conditions in the rule engine', () => {
  test('a provider condition that passes lets the rule fire', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({
        conditions: [
          { kind: 'provider', providerId: 'core.has_role', config: { roleIds: [ROLE_A] } },
        ],
      }),
    ];

    const { executor, report } = run(rules, { registry });
    await report;

    expect(executor.requests).toHaveLength(1);
  });

  test('a provider condition that fails skips the rule with the provider wording', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({
        conditions: [
          { kind: 'provider', providerId: 'core.has_role', config: { roleIds: [ROLE_B] } },
        ],
      }),
    ];

    const { executor, report } = run(rules, { registry });
    const outcomes = (await report).outcomes;

    expect(executor.requests).toHaveLength(0);
    expect(outcomes[0]?.skipped?.conditionKind).toBe('provider');
    expect(skipReason(outcomes)).toContain(`<@&${ROLE_B}>`);
  });

  test('a legacy role-has is migrated and judged by the provider', async () => {
    const registry = new ProviderRegistry();
    const rules = [rule({ conditions: [{ kind: 'role-has', roleIds: [ROLE_A] }] })];

    const { executor, report } = run(rules, { registry });
    const outcomes = (await report).outcomes;

    expect(executor.requests).toHaveLength(1);
    expect(outcomes[0]?.fired).toBe(true);
  });

  test('a legacy account-age still keeps the rule from firing when it should', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({
        conditions: [{ kind: 'account-age', operator: 'younger-than', duration: '1s' }],
      }),
    ];

    const { executor, report } = run(rules, { registry });

    await report;
    expect(executor.requests).toHaveLength(0);
  });

  test('a rule with no registry wired names the missing port', async () => {
    const rules = [
      rule({
        conditions: [{ kind: 'provider', providerId: 'leveling.level', config: { min: 5 } }],
      }),
    ];

    const { executor, report } = run(rules);

    await report;
    expect(executor.requests).toHaveLength(0);
    expect(skipReason((await report).outcomes)).toContain('ProviderRegistry');
  });

  test('a provider whose owning module is not loaded says so rather than firing', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({
        conditions: [{ kind: 'provider', providerId: 'leveling.level', config: { min: 5 } }],
      }),
    ];

    const { executor, report } = run(rules, { registry });

    await report;
    expect(executor.requests).toHaveLength(0);
    expect(skipReason((await report).outcomes)).toContain('not running in this deployment');
  });

  test('unreadable provider settings skip the rule instead of throwing', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({ conditions: [{ kind: 'provider', providerId: 'core.has_role', config: {} }] }),
    ];

    const { executor, report } = run(rules, { registry });

    await report;
    expect(executor.requests).toHaveLength(0);
    expect(skipReason((await report).outcomes)).toContain('Has a role');
  });
});

describe('condition ordering', () => {
  test('a failing fact condition short-circuits before any provider is consulted', async () => {
    const counted = countingCondition('leveling.level', 'leveling');
    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [counted.provider] });

    const rules = [
      rule({
        conditions: [
          { kind: 'channel-in', channelIds: ['500000000000000009'] },
          { kind: 'provider', providerId: 'leveling.level', config: { min: 1 } },
        ],
      }),
    ];

    await run(rules, { registry }).report;

    expect(counted.calls.single + counted.calls.batch).toBe(0);
  });

  // The rate window WRITES on every hit, so a rule the providers already ruled out must never
  // reach it — otherwise a member who cannot qualify still consumes the escalation ladder.
  test('a failing provider condition short-circuits before the rate window is hit', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({
        conditions: [
          { kind: 'provider', providerId: 'core.has_role', config: { roleIds: [ROLE_B] } },
          { kind: 'rate-over-window', limit: 2, window: '1m' },
        ],
      }),
    ];

    const { rateWindow, report } = run(rules, { registry });
    await report;

    expect(rateWindow.hits).toHaveLength(0);
  });
});

describe('member context loading', () => {
  test('a loader supplies facts the dispatch never carried', async () => {
    const registry = new ProviderRegistry();

    const loaded: MemberContext = {
      guildId: GUILD,
      userId: MEMBER,
      member: {
        joinedAt: new Date('2020-01-01T00:00:00.000Z'),
        roleIds: [ROLE_A],
        premiumSince: new Date('2026-01-01T00:00:00.000Z'),
        communicationDisabledUntil: null,
      },
      user: { createdAt: new Date('2019-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
      tier: 'free',
      now: new Date(NOW),
    };

    const loader: MemberContextLoader = {
      async load() {
        return new Map([[MEMBER, loaded]]);
      },
    };

    const rules = [
      rule({ conditions: [{ kind: 'provider', providerId: 'core.is_booster', config: {} }] }),
    ];

    const { executor, report } = run(rules, { registry, memberContext: loader });
    await report;

    expect(executor.requests).toHaveLength(1);
  });

  test('without a loader the dispatch facts are used and unknowns are explained', async () => {
    const registry = new ProviderRegistry();
    const rules = [
      rule({ conditions: [{ kind: 'provider', providerId: 'core.is_booster', config: {} }] }),
    ];

    const { executor, report } = run(rules, { registry });

    await report;
    expect(executor.requests).toHaveLength(0);
  });
});
