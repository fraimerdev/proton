import { describe, expect, test } from 'bun:test';
import type { ActionExecutor, ActionRequest, ActionResult } from '../../src/actions/types.ts';
import type { ProtonEvent } from '../../src/events/types.ts';
import { RULE_ENGINE_ACTOR, RuleEngine } from '../../src/rules/engine.ts';
import type { RateWindowHit, RateWindowStore } from '../../src/rules/rate-window.ts';
import type { GuildRule } from '../../src/rules/types.ts';

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const CHANNEL = '500000000000000000';
const MODLOG = '500000000000000001';
const MEMBER = '400000000000000000';
const ROLE = '600000000000000000';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

class FakeExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  readonly throwOn = new Set<string>();
  result: ActionResult = { status: 'executed', caseId: 'case-1' };

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    if (this.throwOn.has(request.kind)) throw new Error(`boom: ${request.kind}`);
    return this.result;
  }
}

class FakeRateWindow implements RateWindowStore {
  readonly hits: RateWindowHit[] = [];
  tripped = true;
  count = 5;

  async hit(input: RateWindowHit) {
    this.hits.push(input);
    return { count: this.count, tripped: this.tripped };
  }
}

function engine(deps: { executor?: FakeExecutor; rateWindow?: FakeRateWindow } = {}) {
  const executor = deps.executor ?? new FakeExecutor();
  const rateWindow = deps.rateWindow ?? new FakeRateWindow();
  return { engine: new RuleEngine({ executor, rateWindow, now: () => NOW }), executor, rateWindow };
}

function rule(overrides: Partial<GuildRule> = {}): GuildRule {
  return {
    id: 'block-invites',
    guildId: GUILD,
    moduleId: 'automod',
    trigger: { kind: 'event', event: 'message.created' },
    conditions: [],
    actions: [{ kind: 'timeout', duration: '10m', reason: 'Advertising' }],
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function event(overrides: Partial<ProtonEvent> = {}): ProtonEvent {
  return {
    id: 'message.created:1234',
    type: 'message.created',
    guildId: GUILD,
    occurredAt: NOW,
    payload: {},
    ...overrides,
  };
}

const FACTS = { actorId: MEMBER, channelId: CHANNEL, content: 'discord.gg/spam' };

function evaluate(rules: GuildRule[], deps: Parameters<typeof engine>[0] = {}, dryRun = false) {
  const built = engine(deps);
  return {
    ...built,
    report: built.engine.evaluate({ event: event(), rules, facts: FACTS, dryRun }),
  };
}

describe('RuleEngine.evaluate', () => {
  test('a matching rule dispatches its actions through the executor (I1)', async () => {
    const { executor, report } = evaluate([rule()]);
    const outcomes = (await report).outcomes;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.fired).toBe(true);
    expect(executor.requests).toHaveLength(1);

    const request = executor.requests[0];
    expect(request?.kind).toBe('timeout');
    expect(request?.guildId).toBe(GUILD);
    expect(request?.moduleId).toBe('automod');

    expect(request?.actorId).toBe(RULE_ENGINE_ACTOR);
    expect(request?.targetId).toBe(MEMBER);
    expect(request?.reason).toBe('Advertising');
    expect(request?.dryRun).toBe(false);
  });

  test('ignores rules whose trigger does not match the event', async () => {
    const other = rule({ id: 'welcome', trigger: { kind: 'event', event: 'member.joined' } });
    const cron = rule({ id: 'nightly', trigger: { kind: 'cron', cron: '0 3 * * *' } });

    const { executor, report } = evaluate([other, cron]);

    expect((await report).outcomes).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
  });

  test('a disabled rule is skipped, and the report says so', async () => {
    const { executor, report } = evaluate([rule({ enabled: false })]);
    const outcome = (await report).outcomes[0];

    expect(outcome?.fired).toBe(false);
    expect(outcome?.skipped?.code).toBe('disabled');
    expect(executor.requests).toHaveLength(0);
  });

  test('rules run in priority order, lowest first', async () => {
    const rules = [
      rule({ id: 'third', priority: 30, actions: [{ kind: 'kick' }] }),
      rule({ id: 'first', priority: 10, actions: [{ kind: 'ban' }] }),
      rule({ id: 'second', priority: 20, actions: [{ kind: 'timeout', duration: '5m' }] }),
    ];

    const { executor, report } = evaluate(rules);
    await report;

    expect(executor.requests.map((r) => r.kind)).toEqual(['ban', 'timeout', 'kick']);
  });

  test('equal priorities keep a stable, documented order', async () => {
    const rules = [
      rule({ id: 'b', moduleId: 'automod', priority: 5, actions: [{ kind: 'kick' }] }),
      rule({ id: 'a', moduleId: 'automod', priority: 5, actions: [{ kind: 'ban' }] }),
    ];

    const { executor, report } = evaluate(rules);
    await report;

    expect(executor.requests.map((r) => r.kind)).toEqual(['ban', 'kick']);
  });

  test('an action that throws stops neither the rest of the rule nor later rules', async () => {
    const executor = new FakeExecutor();
    executor.throwOn.add('ban');

    const rules = [
      rule({
        id: 'first',
        priority: 1,
        actions: [{ kind: 'ban' }, { kind: 'send', payload: { content: 'banned' } }],
      }),
      rule({ id: 'second', priority: 2, actions: [{ kind: 'kick' }] }),
    ];

    const { report } = evaluate(rules, { executor });
    const outcomes = (await report).outcomes;

    expect(executor.requests.map((r) => r.kind)).toEqual(['ban', 'send', 'kick']);
    expect(outcomes[0]?.actions[0]?.error).toContain('boom: ban');
    expect(outcomes[0]?.actions[1]?.result?.status).toBe('executed');
    expect(outcomes[1]?.fired).toBe(true);
  });

  test('a failed action is reported without pretending the rule did not fire', async () => {
    const executor = new FakeExecutor();
    executor.result = {
      status: 'failed_precheck',
      failure: { code: 'missing_permission', humanReason: "I'm missing Ban Members." },
    };

    const { report } = evaluate([rule({ actions: [{ kind: 'ban' }] })], { executor });
    const outcome = (await report).outcomes[0];

    expect(outcome?.fired).toBe(true);
    expect(outcome?.actions[0]?.result?.failure?.humanReason).toContain('Ban Members');
  });

  test('a condition that does not match names the predicate and the reason', async () => {
    const guarded = rule({
      conditions: [{ kind: 'channel-in', channelIds: [MODLOG] }],
    });

    const { executor, report } = evaluate([guarded]);
    const outcome = (await report).outcomes[0];

    expect(outcome?.fired).toBe(false);
    expect(outcome?.skipped?.code).toBe('condition-failed');
    expect(outcome?.skipped?.conditionKind).toBe('channel-in');
    expect(outcome?.skipped?.humanReason).toContain(CHANNEL);
    expect(executor.requests).toHaveLength(0);
  });

  test('all conditions must hold', async () => {
    const both = rule({
      conditions: [
        { kind: 'channel-in', channelIds: [CHANNEL] },
        { kind: 'content-pattern', pattern: 'discord\\.gg' },
      ],
    });

    expect((await evaluate([both]).report).outcomes[0]?.fired).toBe(true);

    const impossible = rule({
      conditions: [
        { kind: 'channel-in', channelIds: [CHANNEL] },
        { kind: 'content-pattern', pattern: 'never-in-this-message' },
      ],
    });

    expect((await evaluate([impossible]).report).outcomes[0]?.fired).toBe(false);
  });

  test('refuses a rule that belongs to another guild', async () => {
    const { executor, report } = evaluate([rule({ guildId: OTHER_GUILD })]);
    const outcome = (await report).outcomes[0];

    expect(outcome?.skipped?.code).toBe('wrong-guild');
    expect(outcome?.skipped?.humanReason).toContain(OTHER_GUILD);
    expect(executor.requests).toHaveLength(0);
  });

  test('a rule stored in a shape we cannot read is reported, not swallowed', async () => {
    const broken = { ...rule(), conditions: [{ kind: 'moon-phase' }] } as unknown as GuildRule;

    const { executor, report } = evaluate([broken]);
    const outcome = (await report).outcomes[0];

    expect(outcome?.skipped?.code).toBe('invalid-rule');
    expect(outcome?.skipped?.humanReason).toContain('conditions');
    expect(executor.requests).toHaveLength(0);
  });

  test('an event outside any guild fires nothing', async () => {
    const { engine: ruleEngine, executor } = engine();
    const report = await ruleEngine.evaluate({
      event: event({ guildId: null }),
      rules: [rule()],
      facts: FACTS,
      dryRun: false,
    });

    expect(report.outcomes[0]?.skipped?.code).toBe('no-guild');
    expect(executor.requests).toHaveLength(0);
  });
});

describe('RuleEngine action requests', () => {
  test('fills the target from the event so a preset never hardcodes an id', async () => {
    const { executor, report } = evaluate([rule({ actions: [{ kind: 'add_role' }] })]);
    await report;

    expect(executor.requests[0]?.payload).toEqual({ userId: MEMBER });
  });

  test('what the rule states wins over what the engine inferred', async () => {
    const rules = [
      rule({
        actions: [{ kind: 'send', payload: { channelId: MODLOG, content: 'logged' } }],
      }),
    ];

    const { executor, report } = evaluate(rules);
    await report;

    expect(executor.requests[0]?.payload).toEqual({ channelId: MODLOG, content: 'logged' });
  });

  test('a role action keeps the role the rule named and the member from the event', async () => {
    const rules = [rule({ actions: [{ kind: 'add_role', payload: { roleId: ROLE } }] })];

    const { executor, report } = evaluate(rules);
    await report;

    expect(executor.requests[0]?.payload).toEqual({ userId: MEMBER, roleId: ROLE });
    expect(executor.requests[0]?.targetId).toBe(MEMBER);
  });

  test('a timeout duration becomes Discord’s own expiry, not a scheduled reversal', async () => {
    const { executor, report } = evaluate([
      rule({ actions: [{ kind: 'timeout', duration: '10m' }] }),
    ]);
    await report;

    expect(executor.requests[0]?.payload).toEqual({
      userId: MEMBER,
      until: new Date(NOW + 600_000),
    });
    expect(executor.requests[0]?.expiresAt).toBeUndefined();
  });

  test('any other duration becomes expiresAt, for the reversal scheduler', async () => {
    const { executor, report } = evaluate([rule({ actions: [{ kind: 'ban', duration: '2h' }] })]);
    await report;

    expect(executor.requests[0]?.expiresAt).toEqual(new Date(NOW + 7_200_000));
  });

  test('idempotency keys are derived from the event, rule and action index', async () => {
    const rules = [
      rule({ actions: [{ kind: 'ban' }, { kind: 'send', payload: { content: 'x' } }] }),
    ];

    const first = evaluate(rules);
    await first.report;
    const second = evaluate(rules);
    await second.report;

    expect(first.executor.requests.map((r) => r.idempotencyKey)).toEqual([
      'rule:message.created:1234:automod:block-invites:0',
      'rule:message.created:1234:automod:block-invites:1',
    ]);
    expect(second.executor.requests.map((r) => r.idempotencyKey)).toEqual(
      first.executor.requests.map((r) => r.idempotencyKey),
    );
  });

  test('dry run is passed straight through to the executor (I12)', async () => {
    const { executor, report } = evaluate([rule()], {}, true);
    await report;

    expect(executor.requests[0]?.dryRun).toBe(true);
  });
});

describe('RuleEngine rate conditions', () => {
  test('fires only when the window trips', async () => {
    const rateWindow = new FakeRateWindow();
    rateWindow.tripped = false;
    rateWindow.count = 3;

    const spammy = rule({ conditions: [{ kind: 'rate-over-window', limit: 5, window: '10s' }] });
    const { executor, report } = evaluate([spammy], { rateWindow });
    const outcome = (await report).outcomes[0];

    expect(outcome?.fired).toBe(false);
    expect(outcome?.skipped?.conditionKind).toBe('rate-over-window');
    expect(outcome?.skipped?.humanReason).toContain('3 of 5');
    expect(executor.requests).toHaveLength(0);
  });

  test('counts per actor, keyed by module and rule, and uses the event as the member', async () => {
    const rateWindow = new FakeRateWindow();
    const spammy = rule({ conditions: [{ kind: 'rate-over-window', limit: 5, window: '10s' }] });

    await evaluate([spammy], { rateWindow }).report;

    expect(rateWindow.hits[0]).toMatchObject({
      guildId: GUILD,
      ruleId: 'automod:block-invites',
      actorId: MEMBER,
      windowMs: 10_000,
      limit: 5,
      member: 'message.created:1234',
    });
  });

  test('a guild-scoped window counts everyone together', async () => {
    const rateWindow = new FakeRateWindow();
    const raid = rule({
      conditions: [{ kind: 'rate-over-window', limit: 10, window: '30s', scope: 'guild' }],
    });

    await evaluate([raid], { rateWindow }).report;

    expect(rateWindow.hits[0]?.actorId).toBe('guild');
  });

  test('does not touch the counter when a fact condition already refused', async () => {
    const rateWindow = new FakeRateWindow();
    const scoped = rule({
      conditions: [
        { kind: 'rate-over-window', limit: 5, window: '10s' },
        { kind: 'channel-in', channelIds: [MODLOG] },
      ],
    });

    await evaluate([scoped], { rateWindow }).report;

    expect(rateWindow.hits).toHaveLength(0);
  });

  test('a rate store that is down skips the rule instead of throwing', async () => {
    const rateWindow = new FakeRateWindow();
    rateWindow.hit = async () => {
      throw new Error('redis unreachable');
    };

    const spammy = rule({ conditions: [{ kind: 'rate-over-window', limit: 5, window: '10s' }] });
    const { report } = evaluate([spammy], { rateWindow });
    const outcome = (await report).outcomes[0];

    expect(outcome?.fired).toBe(false);
    expect(outcome?.skipped?.humanReason).toContain('redis unreachable');
  });

  test('refuses a rule carrying two rate conditions rather than sharing one counter', async () => {
    const doubled = {
      ...rule(),
      conditions: [
        { kind: 'rate-over-window', limit: 5, window: '10s' },
        { kind: 'rate-over-window', limit: 9, window: '60s' },
      ],
    } as unknown as GuildRule;

    const { report } = evaluate([doubled]);
    const outcome = (await report).outcomes[0];

    expect(outcome?.skipped?.code).toBe('invalid-rule');
    expect(outcome?.skipped?.humanReason).toContain('at most one rate-over-window');
  });
});
