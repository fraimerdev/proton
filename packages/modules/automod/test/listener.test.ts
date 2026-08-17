import { describe, expect, test } from 'bun:test';
import type { GuildState, RateWindowHit, RateWindowResult, RateWindowStore } from '@proton/core';
import { dispatches } from '@proton/fixtures';
import type { AutomodDeps } from '../src/deps.ts';
import { createAutomodExecutionListener } from '../src/execution.ts';
import { createAutomodListener } from '../src/listener.ts';
import { RULE_NAMES } from '../src/native.ts';
import { BOT, config, GUILD, harness, MEMBER, protonEvent } from './harness.ts';

const NEVER_TRIPS: RateWindowStore = {
  async hit(_input: RateWindowHit): Promise<RateWindowResult> {
    return { count: 1, tripped: false };
  },
};

const EMPTY_STATE: GuildState = {
  guildId: GUILD,
  ownerId: '1',
  everyoneRoleId: GUILD,
  roles: new Map(),
  botRoleIds: [],
  channels: new Map(),
  updatedAt: 0,
};

function deps(over: Partial<AutomodDeps> = {}): AutomodDeps {
  return {
    rateWindow: NEVER_TRIPS,
    guildState: {
      async get() {
        return EMPTY_STATE;
      },
    },
    botUserId: BOT,
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: '1400000000000000005',
    channel_id: '500000000000000001',
    author: { id: MEMBER, bot: false },
    type: 0,
    content: '',
    mentions: [],
    mention_roles: [],
    attachments: [],
    ...over,
  };
}

describe('createAutomodListener', () => {
  test('a disabled module reads nothing and does nothing', async () => {
    const h = harness(config({ enabled: false, invitesSeverity: 'high' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.executor.requests).toEqual([]);
  });

  test('a clean message is left alone', async () => {
    const h = harness(config({ invitesSeverity: 'high' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'hello there' })),
      h.ctx,
    );

    expect(h.executor.requests).toEqual([]);
  });

  test('a match deletes the message and applies the severity response', async () => {
    const h = harness(config({ invitesSeverity: 'high', highResponse: 'timeout' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.executor.kinds()).toEqual(['delete_message', 'timeout']);
  });

  test('the timeout is bounded by what Discord accepts', async () => {
    const h = harness(
      config({ invitesSeverity: 'high', highResponse: 'timeout', highTimeout: '30d' }),
    );
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    const timeout = h.executor.requests.find((request) => request.kind === 'timeout');
    const until = (timeout?.payload as { until: Date } | undefined)?.until.getTime() ?? 0;

    expect(until - 1_700_000_000_000).toBeLessThanOrEqual(28 * 24 * 60 * 60 * 1000);
    expect(until).toBeGreaterThan(1_700_000_000_000);
  });

  test('a response of none still deletes', async () => {
    const h = harness(config({ invitesSeverity: 'low', lowResponse: 'none', deleteFrom: 'low' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.executor.kinds()).toEqual(['delete_message']);
  });

  test('deleteFrom never leaves the message up and still punishes', async () => {
    const h = harness(
      config({ invitesSeverity: 'high', highResponse: 'warn', deleteFrom: 'never' }),
    );
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.executor.kinds()).toEqual(['warn']);
  });

  test('every punishable offence feeds the escalation ladder', async () => {
    const h = harness(config({ invitesSeverity: 'high', highResponse: 'timeout' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.published.map((entry) => entry.type)).toEqual(['moderation.warned']);
    expect(h.published[0]?.payload).toMatchObject({ userId: MEMBER });
  });

  test('a kicked member is not also escalated', async () => {
    const h = harness(config({ invitesSeverity: 'high', highResponse: 'kick' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.published).toEqual([]);
  });

  test('a failed punishment does not claim to have escalated', async () => {
    const h = harness(config({ invitesSeverity: 'high', highResponse: 'timeout' }));
    h.executor.results.timeout = {
      status: 'failed_precheck',
      failure: { code: 'missing_permission', humanReason: 'Proton is missing Timeout Members' },
    };

    const listener = createAutomodListener(deps());
    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.published).toEqual([]);
    expect(h.logs.join('\n')).toContain('Timeout Members');
  });

  test('an unbound module says so instead of silently reading every message', async () => {
    const h = harness(config({ invitesSeverity: 'high' }));
    const listener = createAutomodListener({});

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.executor.requests).toEqual([]);
    expect(h.logs.join('\n')).toContain('rateWindow');
  });

  test('an alert names the check and cannot ping the server', async () => {
    const h = harness(
      config({
        invitesSeverity: 'high',
        highResponse: 'warn',
        alertChannelId: '500000000000000009',
      }),
    );
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.created', message({ content: 'join discord.gg/abcdef' })),
      h.ctx,
    );

    const alert = h.executor.requests.find((request) => request.kind === 'send');
    const payload = alert?.payload as { content: string; allowedMentions: { parse: string[] } };

    expect(payload.content).toContain('invites');
    expect(payload.allowedMentions.parse).toEqual([]);
  });

  test('an exempt role is never acted on', async () => {
    const h = harness(config({ invitesSeverity: 'high', exemptRoleIds: ['700000000000000001'] }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent(
        'message.created',
        message({ content: 'join discord.gg/abcdef', member: { roles: ['700000000000000001'] } }),
      ),
      h.ctx,
    );

    expect(h.executor.requests).toEqual([]);
  });

  test('an edited message is screened like a new one', async () => {
    const h = harness(config({ invitesSeverity: 'high', highResponse: 'warn' }));
    const listener = createAutomodListener(deps());

    await listener.handler(
      protonEvent('message.updated', message({ content: 'now with discord.gg/abcdef' })),
      h.ctx,
    );

    expect(h.executor.kinds()).toContain('warn');
  });
});

describe('createAutomodExecutionListener', () => {
  const execution = dispatches.automodExecution.d;

  function ruleList(over: Record<string, unknown> = {}) {
    return [
      {
        id: '800000000000000001',
        name: RULE_NAMES.keywords,
        creator_id: BOT,
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: {},
        actions: [],
        enabled: true,
        exempt_roles: [],
        exempt_channels: [],
        ...over,
      },
    ];
  }

  test('a rule Proton owns records a case and escalates', async () => {
    const h = harness();
    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          return ruleList();
        },
      }),
    );

    await listener.handler(protonEvent('automod.executed', execution), h.ctx);

    expect(h.executor.kinds()).toEqual(['warn']);
    expect(h.published.map((entry) => entry.type)).toEqual(['moderation.warned']);
  });

  test('the case reason says what Discord matched', async () => {
    const h = harness();
    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          return ruleList();
        },
      }),
    );

    await listener.handler(protonEvent('automod.executed', execution), h.ctx);

    expect(h.executor.requests[0]?.reason).toContain('free nitro');
  });

  test('an admin’s own rule is left to them', async () => {
    const h = harness();
    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          return ruleList({ creator_id: '300000000000000001', name: 'No politics' });
        },
      }),
    );

    await listener.handler(protonEvent('automod.executed', execution), h.ctx);

    expect(h.executor.requests).toEqual([]);
    expect(h.published).toEqual([]);
  });

  test('an unreadable rule list does not escalate on a guess', async () => {
    const h = harness();
    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          throw new Error('403');
        },
      }),
    );

    await listener.handler(protonEvent('automod.executed', execution), h.ctx);

    expect(h.executor.requests).toEqual([]);
  });

  test('the rule list is read once per guild, not once per blocked message', async () => {
    const h = harness();
    let reads = 0;
    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          reads += 1;
          return ruleList();
        },
      }),
    );

    for (const id of ['evt-1', 'evt-2', 'evt-3']) {
      await listener.handler(protonEvent('automod.executed', execution, id), h.ctx);
    }

    expect(reads).toBe(1);
    expect(h.executor.requests).toHaveLength(3);
  });

  test('the cache expires so a rule deleted in Discord stops counting', async () => {
    const h = harness();
    let reads = 0;
    let clock = 0;

    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          reads += 1;
          return reads === 1 ? ruleList() : [];
        },
      }),
      { ttlMs: 1000, now: () => clock },
    );

    await listener.handler(protonEvent('automod.executed', execution, 'evt-1'), h.ctx);
    clock = 5000;
    await listener.handler(protonEvent('automod.executed', execution, 'evt-2'), h.ctx);

    expect(reads).toBe(2);
    expect(h.executor.requests).toHaveLength(1);
  });

  test('a redelivered execution does not warn twice', async () => {
    const h = harness();
    h.executor.results.warn = { status: 'skipped_duplicate' };

    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          return ruleList();
        },
      }),
    );

    await listener.handler(protonEvent('automod.executed', execution), h.ctx);

    expect(h.published).toEqual([]);
  });

  test('a blocked message with no message id is still handled', async () => {
    const h = harness();
    const listener = createAutomodExecutionListener(
      deps({
        async readNativeRules() {
          return ruleList({ id: '800000000000000002', trigger_type: 4 });
        },
      }),
    );

    await listener.handler(
      protonEvent('automod.executed', dispatches.automodExecutionBlocked.d),
      h.ctx,
    );

    expect(h.executor.kinds()).toEqual(['warn']);
  });
});
