import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type EventBus,
  type EventType,
  type GuildRule,
  type Logger,
  type ModuleManifest,
  ModuleRegistry,
  Permissions,
  type ProtonEvent,
  type RateWindowStore,
  type RuleDefinition,
  RuleEngine,
  type SubscribeOptions,
  type Subscription,
} from '@proton/core';
import type { GuildRuleStore } from '@proton/db';
import { z } from 'zod';
import { ConfigUnavailableError } from '../src/config-provider.ts';
import {
  cronSchedulesFor,
  fireCronRule,
  RULE_DISPATCH_GROUP,
  RuleDispatchRuntime,
  RulePresetSeeder,
  ruleIsDryRun,
  ruleTriggerEvents,
  splitByDryRun,
} from '../src/rule-runtime.ts';
import type { ConfigProvider } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const MEMBER = '100000000000000001';
const CHANNEL = '500000000000000001';

const configSchema = z.object({ enabled: z.boolean() });

function manifest(id: string, rules: RuleDefinition[]): ModuleManifest {
  return {
    id,
    name: id,
    category: 'moderation',
    configSchema,
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [Permissions.ViewChannel],
    rules,
  } as unknown as ModuleManifest;
}

function rule(overrides: Partial<GuildRule> = {}): GuildRule {
  return {
    id: 'ban-spammers',
    guildId: GUILD,
    moduleId: 'moderation',
    trigger: { kind: 'event', event: 'message.created' },
    conditions: [],
    actions: [{ kind: 'send', payload: { content: 'caught one' } }],
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function event(type: EventType = 'message.created', overrides: Partial<ProtonEvent> = {}) {
  return {
    id: `${type}:1`,
    type,
    guildId: GUILD,
    occurredAt: 1_770_000_000_000,
    payload: { id: '1', channel_id: CHANNEL, content: 'hello', author: { id: MEMBER } },
    ...overrides,
  } satisfies ProtonEvent;
}

function recordingExecutor(): { executor: ActionExecutor; requests: ActionRequest[] } {
  const requests: ActionRequest[] = [];
  return {
    requests,
    executor: {
      execute: async (request): Promise<ActionResult> => {
        requests.push(request);
        return { status: request.dryRun ? 'dry_run' : 'executed' };
      },
    },
  };
}

const trippingWindow: RateWindowStore = {
  hit: async () => ({ count: 3, tripped: true }),
};

function collectingLogger(): { logger: Logger; lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push({ level: 'info', message }),
      warn: (message) => lines.push({ level: 'warn', message }),
      error: (message) => lines.push({ level: 'error', message }),
    },
  };
}

interface StoreCall {
  guildId: string;
  eventType: EventType;
}

function fakeStore(
  rules: GuildRule[],
  options: { cron?: GuildRule[]; throws?: Error } = {},
): { store: GuildRuleStore; reads: StoreCall[]; seeded: Array<[string, string, number]> } {
  const reads: StoreCall[] = [];
  const seeded: Array<[string, string, number]> = [];

  return {
    reads,
    seeded,
    store: {
      listForEvent: async (guildId, eventType) => {
        reads.push({ guildId, eventType });
        if (options.throws) throw options.throws;
        return rules.filter((r) => r.trigger.kind === 'event' && r.trigger.event === eventType);
      },
      listCron: async () => options.cron ?? [],
      seedPresets: async (guildId, moduleId, presets) => {
        if (options.throws) throw options.throws;
        seeded.push([guildId, moduleId, presets.length]);
        return presets.length;
      },
      // Config-driven recompiles come from the API, not the worker; the runtime never calls this.
      replaceModuleRules: async (_guildId, _moduleId, compiled) => compiled.length,
    },
  };
}

const allEnabled: ConfigProvider = {
  async get() {
    return { enabled: true, config: { enabled: true } };
  },
};

interface SubscribeCall {
  group: string;
  types: EventType[];
  options: SubscribeOptions | undefined;
}

function recordingBus(): { bus: EventBus; calls: SubscribeCall[] } {
  const calls: SubscribeCall[] = [];
  return {
    calls,
    bus: {
      publish: async () => undefined,
      subscribe: (group, types, _handler, options): Subscription => {
        calls.push({ group, types, options });
        return { group, close: async () => undefined };
      },
    },
  };
}

function build(options: {
  manifests?: ModuleManifest[];
  rules?: GuildRule[];
  config?: ConfigProvider;
  nodeEnv?: string;
  storeThrows?: Error;
}) {
  const registry = new ModuleRegistry();
  for (const m of options.manifests ?? [manifest('moderation', [])]) registry.register(m);

  const { executor, requests } = recordingExecutor();
  const { logger, lines } = collectingLogger();
  const { bus, calls } = recordingBus();
  const { store, reads } = fakeStore(options.rules ?? [], {
    ...(options.storeThrows ? { throws: options.storeThrows } : {}),
  });

  const runtime = new RuleDispatchRuntime({
    bus,
    registry,
    engine: new RuleEngine({ executor, rateWindow: trippingWindow }),
    store,
    config: options.config ?? allEnabled,
    logger,

    nodeEnv: options.nodeEnv ?? 'production',
  });

  return { runtime, requests, lines, calls, reads, registry };
}

describe('which events the engine listens for', () => {
  test('the union of every manifest rule that triggers on an event, deduped', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest('cases', [
        {
          id: 'a',
          trigger: { kind: 'event', event: 'moderation.warned' },
          conditions: [],
          actions: [{ kind: 'timeout', duration: '1h' }],
          enabled: true,
          priority: 0,
        },
      ]),
    );
    registry.register(
      manifest('autorole', [
        {
          id: 'b',
          trigger: { kind: 'event', event: 'member.joined' },
          conditions: [],
          actions: [{ kind: 'add_role', payload: { roleId: '1' } }],
          enabled: true,
          priority: 0,
        },
        {
          id: 'c',
          trigger: { kind: 'event', event: 'member.joined' },
          conditions: [],
          actions: [{ kind: 'add_role', payload: { roleId: '2' } }],
          enabled: true,
          priority: 0,
        },
      ]),
    );

    expect(ruleTriggerEvents(registry).sort()).toEqual(['member.joined', 'moderation.warned']);
  });

  test('a cron rule contributes no event type', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest('cases', [
        {
          id: 'nightly',
          trigger: { kind: 'cron', cron: '0 3 * * *' },
          conditions: [],
          actions: [{ kind: 'send', payload: { channelId: CHANNEL, content: 'swept' } }],
          enabled: true,
          priority: 0,
        },
      ]),
    );

    expect(ruleTriggerEvents(registry)).toEqual([]);
  });
});

describe('subscription shape', () => {
  const withRules = manifest('moderation', [
    {
      id: 'ban-spammers',
      trigger: { kind: 'event', event: 'message.created' },
      conditions: [],
      actions: [{ kind: 'send', payload: { content: 'x' } }],
      enabled: true,
      priority: 0,
    },
  ]);

  test('one consumer group for every trigger, not one per module', () => {
    const { runtime, calls } = build({ manifests: [withRules, manifest('cases', [])] });

    runtime.start();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.group).toBe(RULE_DISPATCH_GROUP);
    expect(calls[0]?.types).toEqual(['message.created']);
  });

  test('the group starts at $, not at the head of the stream', () => {
    const { runtime, calls } = build({ manifests: [withRules] });

    runtime.start();

    expect(calls[0]?.options?.startId).toBe('$');
  });

  test('no manifest ships rules, so nothing is subscribed and it says so', () => {
    const { runtime, calls, lines } = build({ manifests: [manifest('moderation', [])] });

    expect(runtime.start()).toEqual([]);
    expect(calls).toEqual([]);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.message).toContain('none can fire');
  });
});

describe('dispatch', () => {
  test('a matching rule dispatches its action through the executor', async () => {
    const { runtime, requests } = build({ rules: [rule()] });

    await runtime.handle(event());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.kind).toBe('send');
    expect(requests[0]?.guildId).toBe(GUILD);
    expect(requests[0]?.moduleId).toBe('moderation');

    expect(requests[0]?.idempotencyKey).toBe('rule:message.created:1:moderation:ban-spammers:0');
  });

  test('the channel is supplied from the facts, not hardcoded in the preset', async () => {
    const { runtime, requests } = build({ rules: [rule()] });

    await runtime.handle(event());

    expect(requests[0]?.payload).toEqual({ channelId: CHANNEL, content: 'caught one' });
  });

  test('a DM is dropped before the store is even read', async () => {
    const { runtime, reads } = build({ rules: [rule()] });

    await runtime.handle(event('message.created', { guildId: null }));

    expect(reads).toEqual([]);
  });

  test('a guild with no rule for this event costs one read and nothing else', async () => {
    const { runtime, requests, reads, lines } = build({ rules: [] });

    await runtime.handle(event());

    expect(reads).toEqual([{ guildId: GUILD, eventType: 'message.created' }]);
    expect(requests).toEqual([]);

    expect(lines).toEqual([]);
  });

  test('a rule whose module is disabled in this guild does not run', async () => {
    const { runtime, requests } = build({
      rules: [rule()],
      config: {
        async get() {
          return { enabled: false, config: { enabled: true } };
        },
      },
    });

    await runtime.handle(event());

    expect(requests).toEqual([]);
  });

  test('a rule left behind by a module this build no longer loads is named, not run', async () => {
    const { runtime, requests, lines } = build({
      manifests: [manifest('cases', [])],
      rules: [rule({ moduleId: 'moderation' })],
    });

    await runtime.handle(event());

    expect(requests).toEqual([]);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.message).toContain('no module with that id is loaded');
  });

  test("another guild's rule is reported and never dispatched", async () => {
    const { runtime, requests, lines } = build({ rules: [rule({ guildId: OTHER_GUILD })] });

    await runtime.handle(event());

    expect(requests).toEqual([]);
    expect(lines.some((l) => l.message.includes(`belongs to guild ${OTHER_GUILD}`))).toBe(true);
  });

  test('a rule switched off in the dashboard is reported as off', async () => {
    const { runtime, requests, lines } = build({ rules: [rule({ enabled: false })] });

    await runtime.handle(event());

    expect(requests).toEqual([]);
    expect(lines.some((l) => l.message.includes('this rule is off'))).toBe(true);
  });
});

describe('conditions decide, and say why they did not', () => {
  test('a condition that does not match keeps the rule from firing', async () => {
    const { runtime, requests, lines } = build({
      rules: [
        rule({
          conditions: [{ kind: 'content-pattern', pattern: 'discord\\.gg/', mode: 'regex' }],
        }),
      ],
    });

    await runtime.handle(event());

    expect(requests).toEqual([]);
    expect(lines[0]?.level).toBe('info');
    expect(lines[0]?.message).toContain('did not match');
  });

  test('a condition that matches lets it through', async () => {
    const { runtime, requests } = build({
      rules: [
        rule({ conditions: [{ kind: 'content-pattern', pattern: 'hello', mode: 'contains' }] }),
      ],
    });

    await runtime.handle(event());

    expect(requests).toHaveLength(1);
  });

  test('a condition needing a fact this event does not carry names the missing fact', async () => {
    const { runtime, lines } = build({
      rules: [
        rule({
          trigger: { kind: 'event', event: 'member.joined' },
          conditions: [{ kind: 'channel-in', channelIds: [CHANNEL] }],
        }),
      ],
    });

    await runtime.handle(event('member.joined', { payload: { user: { id: MEMBER } } }));

    expect(lines[0]?.message).toContain('outside any channel');
  });

  test('an unparseable rule is logged as an error', async () => {
    const { runtime, lines } = build({
      rules: [rule({ priority: 1.5 })],
    });

    await runtime.handle(event());

    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toContain('not valid');
  });
});

describe('failures are triaged, not treated alike', () => {
  test('a store failure rethrows, so the bus redelivers the event', async () => {
    const { runtime } = build({ rules: [rule()], storeThrows: new Error('postgres is away') });

    await expect(runtime.handle(event())).rejects.toThrow('postgres is away');
  });

  test('a permanent config failure is logged with a remedy and the event is acked', async () => {
    const { runtime, lines } = build({
      rules: [rule()],
      config: {
        async get(guildId, moduleId) {
          throw new ConfigUnavailableError({
            message: `api returned 400 for ${moduleId} in ${guildId}`,
            permanent: true,
            status: 400,
            guildId,
            moduleId,
          });
        },
      },
    });

    await runtime.handle(event());

    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toContain('retrying will not help');
    expect(lines[0]?.message).toContain('save them once');
  });

  test('a transient config failure rethrows, so the event is retried', async () => {
    const { runtime } = build({
      rules: [rule()],
      config: {
        async get(guildId, moduleId) {
          throw new ConfigUnavailableError({
            message: 'api returned 503',
            permanent: false,
            status: 503,
            guildId,
            moduleId,
          });
        },
      },
    });

    await expect(runtime.handle(event())).rejects.toThrow('503');
  });

  test('an action the executor refuses is reported at error, naming the reason', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest('moderation', []));
    const { logger, lines } = collectingLogger();
    const { bus } = recordingBus();
    const { store } = fakeStore([rule()]);

    const runtime = new RuleDispatchRuntime({
      bus,
      registry,
      engine: new RuleEngine({
        executor: {
          execute: async () => ({
            status: 'failed_precheck',
            failure: {
              code: 'missing_permission',
              humanReason: 'I need SEND_MESSAGES in #general.',
            },
          }),
        },
        rateWindow: trippingWindow,
      }),
      store,
      config: allEnabled,
      logger,
      nodeEnv: 'production',
    });

    await runtime.handle(event());

    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toContain('SEND_MESSAGES in #general');
  });
});

describe('dry run (I12)', () => {
  const banRule = rule({ actions: [{ kind: 'ban', reason: 'spam' }] });

  test('a destructive action is withheld outside production', () => {
    expect(ruleIsDryRun(banRule, 'development')).toBe(true);
    expect(ruleIsDryRun(banRule, 'production')).toBe(false);
  });

  test('a non-destructive rule runs for real everywhere', () => {
    expect(ruleIsDryRun(rule(), 'development')).toBe(false);
  });

  test('a rule mixing a ban with a mod-log line is dry-run as a whole', () => {
    const ladder = rule({
      actions: [
        { kind: 'ban', reason: 'spam' },
        { kind: 'send', payload: { content: 'banned for spam' } },
      ],
    });

    expect(ruleIsDryRun(ladder, 'development')).toBe(true);
  });

  test('rules are partitioned so one destructive rule does not mute the others', () => {
    const groups = splitByDryRun([rule(), banRule], 'development');

    expect(groups).toEqual([
      [false, [rule()]],
      [true, [banRule]],
    ]);
  });

  test('in production everything lands in one group, so priority ordering is exact', () => {
    const groups = splitByDryRun([rule(), banRule], 'production');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.[0]).toBe(false);
    expect(groups[0]?.[1]).toHaveLength(2);
  });

  test('the flag reaches the executor, so the action is recorded and not performed', async () => {
    const { runtime, requests } = build({ rules: [banRule], nodeEnv: 'development' });

    await runtime.handle(event());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.dryRun).toBe(true);
  });
});

describe('preset seeding', () => {
  const cases = manifest('cases', [
    {
      id: 'escalate-at-3',
      trigger: { kind: 'event', event: 'moderation.warned' },
      conditions: [{ kind: 'rate-over-window', limit: 3, window: '24h' }],
      actions: [{ kind: 'timeout', duration: '1h' }],
      enabled: true,
      priority: 0,
    },
  ]);

  function seeder(options: {
    manifests: ModuleManifest[];
    cron?: { register(guildId: string): Promise<number> };
    storeThrows?: Error;
  }) {
    const registry = new ModuleRegistry();
    for (const m of options.manifests) registry.register(m);

    const { logger, lines } = collectingLogger();
    const { bus, calls } = recordingBus();
    const { store, seeded } = fakeStore([], {
      ...(options.storeThrows ? { throws: options.storeThrows } : {}),
    });

    return {
      lines,
      calls,
      seeded,
      seeder: new RulePresetSeeder({
        bus,
        registry,
        store,
        logger,
        ...(options.cron ? { cron: options.cron } : {}),
      }),
    };
  }

  test('subscribes to guild.available in its own group', () => {
    const { seeder: s, calls } = seeder({ manifests: [cases] });

    s.start();

    expect(calls[0]?.types).toEqual(['guild.available']);
    expect(calls[0]?.group).toBe('rule-presets');
  });

  test('seeds every manifest that ships rules, and only those', async () => {
    const {
      seeder: s,
      seeded,
      lines,
    } = seeder({
      manifests: [cases, manifest('ping', [])],
    });

    await s.handle({
      id: 'guild.available:1',
      type: 'guild.available',
      guildId: GUILD,
      occurredAt: 1,
      payload: {},
    });

    expect(seeded).toEqual([[GUILD, 'cases', 1]]);
    expect(lines[0]?.message).toContain('seeded 1 preset rule(s)');
  });

  test('a seeding failure rethrows rather than leaving the guild unseeded', async () => {
    const { seeder: s } = seeder({
      manifests: [cases],
      storeThrows: new Error('violates foreign key constraint "rules_guild_id_guilds_id_fk"'),
    });

    await expect(
      s.handle({
        id: 'guild.available:1',
        type: 'guild.available',
        guildId: GUILD,
        occurredAt: 1,
        payload: {},
      }),
    ).rejects.toThrow('foreign key');
  });

  test('a cron registration failure is shouted about, not thrown', async () => {
    const { seeder: s, lines } = seeder({
      manifests: [cases],
      cron: {
        register: async () => {
          throw new Error('redis refused the connection');
        },
      },
    });

    await s.handle({
      id: 'guild.available:1',
      type: 'guild.available',
      guildId: GUILD,
      occurredAt: 1,
      payload: {},
    });

    const failure = lines.find((l) => l.level === 'error');
    expect(failure?.message).toContain('will NOT run until the next time the gateway reconnects');
  });
});

describe('cron rules', () => {
  const nightly = rule({
    id: 'nightly-sweep',
    trigger: { kind: 'cron', cron: '0 3 * * *', timezone: 'America/New_York' },
    actions: [{ kind: 'send', payload: { channelId: CHANNEL, content: 'swept' } }],
  });

  test('one schedule per cron rule, carrying the expression and the timezone', () => {
    expect(cronSchedulesFor(GUILD, [nightly])).toEqual([
      {
        id: `${GUILD}:moderation:nightly-sweep`,
        data: { guildId: GUILD, moduleId: 'moderation', ruleId: 'nightly-sweep' },
        pattern: '0 3 * * *',
        timezone: 'America/New_York',
      },
    ]);
  });

  test('an event rule is never scheduled on a clock as well', () => {
    expect(cronSchedulesFor(GUILD, [rule()])).toEqual([]);
  });

  test('a tick fires the rule through the engine', async () => {
    const { executor, requests } = recordingExecutor();
    const { logger } = collectingLogger();
    const { store } = fakeStore([], { cron: [nightly] });

    await fireCronRule(
      {
        engine: new RuleEngine({ executor, rateWindow: trippingWindow }),
        store,
        logger,
        nodeEnv: 'production',
      },
      {
        id: 'repeat:x:1770000000000',
        name: `${GUILD}:moderation:nightly-sweep`,
        data: { guildId: GUILD, moduleId: 'moderation', ruleId: 'nightly-sweep' },
        timestamp: 1_770_000_000_000,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload).toEqual({ channelId: CHANNEL, content: 'swept' });

    expect(requests[0]?.idempotencyKey).toContain('repeat:x:1770000000000');
  });

  test('a condition that needs facts refuses, because a schedule has none', async () => {
    const { executor, requests } = recordingExecutor();
    const { logger, lines } = collectingLogger();
    const { store } = fakeStore([], {
      cron: [
        {
          ...nightly,
          conditions: [{ kind: 'role-has', roleIds: ['700000000000000001'], match: 'any' }],
        },
      ],
    });

    await fireCronRule(
      { engine: new RuleEngine({ executor, rateWindow: trippingWindow }), store, logger },
      {
        id: 'j1',
        name: 'n',
        data: { guildId: GUILD, moduleId: 'moderation', ruleId: 'nightly-sweep' },
        timestamp: 1,
      },
    );

    expect(requests).toEqual([]);
    expect(lines[0]?.message).toContain('roles are unknown');
  });

  test('a schedule that outlived its rule no-ops and says how to remove it', async () => {
    const { executor, requests } = recordingExecutor();
    const { logger, lines } = collectingLogger();
    const { store } = fakeStore([], { cron: [] });

    await fireCronRule(
      { engine: new RuleEngine({ executor, rateWindow: trippingWindow }), store, logger },
      {
        id: 'j1',
        name: 'n',
        data: { guildId: GUILD, moduleId: 'moderation', ruleId: 'gone' },
        timestamp: 1,
      },
    );

    expect(requests).toEqual([]);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.message).toContain('removeJobScheduler');
  });

  test('a disabled cron rule ticks silently', async () => {
    const { executor, requests } = recordingExecutor();
    const { logger, lines } = collectingLogger();
    const { store } = fakeStore([], { cron: [{ ...nightly, enabled: false }] });

    await fireCronRule(
      { engine: new RuleEngine({ executor, rateWindow: trippingWindow }), store, logger },
      {
        id: 'j1',
        name: 'n',
        data: { guildId: GUILD, moduleId: 'moderation', ruleId: 'nightly-sweep' },
        timestamp: 1,
      },
    );

    expect(requests).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('job data this build cannot read is reported, not retried forever', async () => {
    const { executor, requests } = recordingExecutor();
    const { logger, lines } = collectingLogger();
    const { store } = fakeStore([], { cron: [nightly] });

    await fireCronRule(
      { engine: new RuleEngine({ executor, rateWindow: trippingWindow }), store, logger },
      { id: 'j1', name: 'stale', data: { rule: 'nightly-sweep' }, timestamp: 1 },
    );

    expect(requests).toEqual([]);
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toContain("queue.removeJobScheduler('stale')");
  });
});
