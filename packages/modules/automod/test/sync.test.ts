import { describe, expect, test } from 'bun:test';
import { RULE_NAMES } from '../src/native.ts';
import { syncNativeRules } from '../src/sync.ts';
import { createAutomodSyncListener } from '../src/sync-listener.ts';
import { BOT, config, GUILD, harness, protonEvent } from './harness.ts';

function ruleList(over: Record<string, unknown> = {}) {
  return [
    {
      id: '800000000000000001',
      name: RULE_NAMES.keywords,
      creator_id: BOT,
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ['stale'], regex_patterns: [], allow_list: [] },
      actions: [{ type: 1, metadata: { custom_message: 'Blocked by this server’s automod.' } }],
      enabled: true,
      exempt_roles: [],
      exempt_channels: [],
      ...over,
    },
  ];
}

describe('syncNativeRules', () => {
  test('a fresh guild has its rules created', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));

    const outcome = await syncNativeRules({
      ctx: h.ctx,
      botUserId: BOT,
      async readNativeRules() {
        return [];
      },
    });

    expect(outcome.created).toBe(1);
    expect(h.executor.kinds()).toEqual(['automod_rule_create']);
  });

  test('rule writes never reach the case ledger', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));

    await syncNativeRules({
      ctx: h.ctx,
      botUserId: BOT,
      async readNativeRules() {
        return [];
      },
    });

    expect(h.executor.requests[0]?.record).toBe(false);
  });

  test('a rule an admin edited in Discord is corrected', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));

    const outcome = await syncNativeRules({
      ctx: h.ctx,
      botUserId: BOT,
      async readNativeRules() {
        return ruleList();
      },
    });

    expect(outcome.updated).toBe(1);
    expect(h.executor.requests[0]?.payload).toMatchObject({ ruleId: '800000000000000001' });
  });

  test('an unreadable list changes nothing and says why', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));

    const outcome = await syncNativeRules({
      ctx: h.ctx,
      botUserId: BOT,
      async readNativeRules() {
        throw new Error('403: Missing Access');
      },
    });

    expect(h.executor.requests).toEqual([]);
    expect(outcome.failures.join('\n')).toContain('Manage Server');
  });

  test('two consecutive edits are two calls, not one deduplicated to nothing', async () => {
    const first = harness(config({ blockedWords: ['scam'] }));
    const second = harness(config({ blockedWords: ['scam', 'phish'] }));

    const read = async () => ruleList();
    await syncNativeRules({ ctx: first.ctx, botUserId: BOT, readNativeRules: read });
    await syncNativeRules({ ctx: second.ctx, botUserId: BOT, readNativeRules: read });

    expect(first.executor.requests[0]?.idempotencyKey).not.toBe(
      second.executor.requests[0]?.idempotencyKey,
    );
  });

  test('the same sync run twice asks for the same call', async () => {
    const runs = [];
    for (const _ of [0, 1]) {
      const h = harness(config({ blockedWords: ['scam'] }));
      await syncNativeRules({
        ctx: h.ctx,
        botUserId: BOT,
        async readNativeRules() {
          return [];
        },
      });
      runs.push(h.executor.requests[0]?.idempotencyKey);
    }

    expect(runs[0]).toBe(runs[1] as string);
  });

  test('a failed call is reported rather than counted as done', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));
    h.executor.results.automod_rule_create = {
      status: 'failed_api',
      failure: { code: 'max_rules', humanReason: 'this server already has 6 keyword rules' },
    };

    const outcome = await syncNativeRules({
      ctx: h.ctx,
      botUserId: BOT,
      async readNativeRules() {
        return [];
      },
    });

    expect(outcome.created).toBe(0);
    expect(outcome.failures[0]).toContain('6 keyword rules');
  });
});

describe('createAutomodSyncListener', () => {
  const changed = (moduleId: string) => protonEvent('proton.config_changed', { moduleId });

  test('another module’s config save is ignored', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));
    const listener = createAutomodSyncListener({
      botUserId: BOT,
      async readNativeRules() {
        return [];
      },
    });

    await listener.handler(changed('leveling'), h.ctx);

    expect(h.executor.requests).toEqual([]);
  });

  test('our own config save reconciles', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));
    const listener = createAutomodSyncListener({
      botUserId: BOT,
      async readNativeRules() {
        return [];
      },
    });

    await listener.handler(changed('automod'), h.ctx);

    expect(h.executor.kinds()).toEqual(['automod_rule_create']);
  });

  test('a guild coming available reconciles without a config change', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));
    const listener = createAutomodSyncListener({
      botUserId: BOT,
      async readNativeRules() {
        return [];
      },
    });

    await listener.handler(protonEvent('guild.available', { id: GUILD }), h.ctx);

    expect(h.executor.kinds()).toEqual(['automod_rule_create']);
  });

  test('disabling the module takes its rules down rather than abandoning them', async () => {
    const h = harness(config({ enabled: false, blockedWords: ['scam'] }));
    const listener = createAutomodSyncListener({
      botUserId: BOT,
      async readNativeRules() {
        return ruleList();
      },
    });

    await listener.handler(changed('automod'), h.ctx);

    expect(h.executor.kinds()).toEqual(['automod_rule_delete']);
  });

  test('an unbound port says the native half is not running', async () => {
    const h = harness(config({ blockedWords: ['scam'] }));
    const listener = createAutomodSyncListener({});

    await listener.handler(changed('automod'), h.ctx);

    expect(h.executor.requests).toEqual([]);
    expect(h.logs.join('\n')).toContain('enforced only');
  });
});
