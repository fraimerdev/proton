import { describe, expect, test } from 'bun:test';
import {
  AUTOMOD_ACTION_BLOCK_MESSAGE,
  AUTOMOD_ACTION_SEND_ALERT,
  AUTOMOD_TRIGGER_KEYWORD,
  AUTOMOD_TRIGGER_KEYWORD_PRESET,
  AUTOMOD_TRIGGER_MENTION_SPAM,
  AUTOMOD_TRIGGER_SPAM,
} from '@proton/core';
import { type AutomodConfig, automodConfigSchema } from '../src/config.ts';
import {
  diffNativeRules,
  type ExistingRule,
  isOwned,
  parseNativeRules,
  planNativeRules,
  RULE_NAMES,
} from '../src/native.ts';
import { classifyRegex, splitPatterns } from '../src/regex-compat.ts';

const BOT = '200000000000000001';
const ADMIN = '300000000000000001';

function config(overrides: Record<string, unknown> = {}): AutomodConfig {
  return automodConfigSchema.parse({ enabled: true, ...overrides });
}

function raw(overrides: Record<string, unknown> = {}) {
  return {
    id: '800000000000000001',
    name: RULE_NAMES.keywords,
    creator_id: BOT,
    event_type: 1,
    trigger_type: AUTOMOD_TRIGGER_KEYWORD,
    trigger_metadata: { keyword_filter: ['scam'], regex_patterns: [], allow_list: [] },
    actions: [
      {
        type: AUTOMOD_ACTION_BLOCK_MESSAGE,
        metadata: { custom_message: 'Blocked by this server’s automod.' },
      },
    ],
    enabled: true,
    exempt_roles: [],
    exempt_channels: [],
    ...overrides,
  };
}

describe('classifyRegex', () => {
  test('ordinary patterns go native', () => {
    for (const pattern of ['free\\s+nitro', 'b[a4]dw[o0]rd', '^\\d{4}$', '\\bcrypto\\b|airdrop']) {
      expect(classifyRegex(pattern).native).toBe(true);
    }
  });

  test('constructs Rust has no backtracking for stay in-house', () => {
    for (const pattern of ['foo(?=bar)', 'foo(?!bar)', '(?<=a)b', '(?<!a)b', '(a)\\1', '(?<n>a)']) {
      const verdict = classifyRegex(pattern);
      expect(verdict.native).toBe(false);
    }
  });

  test('an over-long pattern is reported by length, not guessed at', () => {
    const verdict = classifyRegex('a'.repeat(261));
    if (verdict.native) throw new Error('expected an in-house verdict');
    expect(verdict.reason).toContain('261 characters');
  });
});

describe('splitPatterns', () => {
  test('patterns past the cap fall to in-house rather than being dropped', () => {
    const patterns = Array.from({ length: 12 }, (_, i) => `word${i}`);
    const split = splitPatterns(patterns, 10);

    expect(split.native).toHaveLength(10);
    expect(split.inHouse).toHaveLength(2);
    expect(split.native.length + split.inHouse.length).toBe(patterns.length);
  });
});

describe('planNativeRules', () => {
  test('a disabled module wants no rules at all', () => {
    expect(planNativeRules(config({ enabled: false, blockedWords: ['scam'] })).desired).toEqual([]);
  });

  test('nothing configured means nothing pushed', () => {
    expect(planNativeRules(config()).desired).toEqual([]);
  });

  test('each half of the config produces its own rule', () => {
    const plan = planNativeRules(
      config({
        blockedWords: ['scam'],
        presets: ['profanity'],
        mentionLimit: 10,
        nativeSpam: true,
      }),
    );

    expect(plan.desired.map((rule) => rule.triggerType)).toEqual([
      AUTOMOD_TRIGGER_KEYWORD,
      AUTOMOD_TRIGGER_KEYWORD_PRESET,
      AUTOMOD_TRIGGER_MENTION_SPAM,
      AUTOMOD_TRIGGER_SPAM,
    ]);
  });

  test('a translatable pattern rides the keyword rule with no words configured', () => {
    const plan = planNativeRules(config({ regexPatterns: ['free\\s+nitro'] }));

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.triggerMetadata.regexPatterns).toEqual(['free\\s+nitro']);
    expect(plan.inHousePatterns).toEqual([]);
  });

  test('an untranslatable pattern is reported rather than pushed', () => {
    const plan = planNativeRules(config({ regexPatterns: ['scam(?!proof)'] }));

    expect(plan.desired).toEqual([]);
    expect(plan.inHousePatterns[0]?.pattern).toBe('scam(?!proof)');
  });

  test('rules block and alert, and never punish', () => {
    const plan = planNativeRules(
      config({ blockedWords: ['scam'], alertChannelId: '500000000000000001' }),
    );

    expect(plan.desired[0]?.actions.map((action) => action.type)).toEqual([
      AUTOMOD_ACTION_BLOCK_MESSAGE,
      AUTOMOD_ACTION_SEND_ALERT,
    ]);
  });

  test('exemptions are pushed into every rule', () => {
    const plan = planNativeRules(
      config({
        blockedWords: ['scam'],
        nativeSpam: true,
        exemptRoleIds: ['700000000000000001'],
        exemptChannelIds: ['500000000000000001'],
      }),
    );

    for (const rule of plan.desired) {
      expect(rule.exemptRoles).toEqual(['700000000000000001']);
      expect(rule.exemptChannels).toEqual(['500000000000000001']);
    }
  });
});

describe('parseNativeRules', () => {
  test('a non-array body is not a crash', () => {
    expect(parseNativeRules(null)).toEqual([]);
    expect(parseNativeRules({ message: '403: Missing Access' })).toEqual([]);
  });

  test('an unparseable entry is skipped without losing the rest', () => {
    const rules = parseNativeRules([{ nonsense: true }, raw()]);
    expect(rules).toHaveLength(1);
  });

  test('an unknown preset id is dropped rather than failing the rule', () => {
    const rules = parseNativeRules([
      raw({ trigger_type: AUTOMOD_TRIGGER_KEYWORD_PRESET, trigger_metadata: { presets: [1, 99] } }),
    ]);

    expect(rules[0]?.triggerMetadata.presets).toEqual([1]);
  });
});

describe('isOwned', () => {
  const rule = (over: Partial<ExistingRule>): ExistingRule =>
    ({ ...parseNativeRules([raw()])[0], ...over }) as ExistingRule;

  test('a rule Proton created is ours', () => {
    expect(isOwned(rule({ creatorId: BOT }), BOT)).toBe(true);
  });

  test('an admin naming their rule after Proton does not hand it over', () => {
    expect(isOwned(rule({ creatorId: ADMIN, name: RULE_NAMES.keywords }), BOT)).toBe(false);
  });

  test('with no creator the name prefix is the only thing left to go on', () => {
    expect(isOwned(rule({ creatorId: null, name: RULE_NAMES.keywords }), BOT)).toBe(true);
    expect(isOwned(rule({ creatorId: null, name: 'No slurs please' }), BOT)).toBe(false);
  });
});

describe('diffNativeRules', () => {
  test('a rule Proton wants and does not have is created', () => {
    const desired = planNativeRules(config({ blockedWords: ['scam'] })).desired;
    const diff = diffNativeRules(desired, [], BOT);

    expect(diff.ops).toEqual([{ op: 'create', rule: desired[0] as never }]);
  });

  test('an unchanged rule is left completely alone', () => {
    const desired = planNativeRules(config({ blockedWords: ['scam'] })).desired;
    const existing = parseNativeRules([raw()]);
    const diff = diffNativeRules(desired, existing, BOT);

    expect(diff.ops).toEqual([]);
    expect(diff.unchanged).toEqual([RULE_NAMES.keywords]);
  });

  test('an admin editing a Proton rule in Discord has it corrected', () => {
    const desired = planNativeRules(config({ blockedWords: ['scam'] })).desired;
    const existing = parseNativeRules([
      raw({ trigger_metadata: { keyword_filter: ['something else'] } }),
    ]);

    const diff = diffNativeRules(desired, existing, BOT);
    expect(diff.ops).toEqual([
      { op: 'update', ruleId: '800000000000000001', rule: desired[0] as never },
    ]);
  });

  test('a hand-made rule is never touched, whatever it is called', () => {
    const existing = parseNativeRules([
      raw({ id: '900000000000000001', creator_id: ADMIN, name: RULE_NAMES.keywords }),
      raw({ id: '900000000000000002', creator_id: ADMIN, name: 'No politics' }),
    ]);

    const diff = diffNativeRules([], existing, BOT);

    expect(diff.ops).toEqual([]);
    expect(diff.foreign).toEqual([RULE_NAMES.keywords, 'No politics']);
  });

  test('turning a setting off takes its rule down', () => {
    const existing = parseNativeRules([raw()]);
    const diff = diffNativeRules(planNativeRules(config()).desired, existing, BOT);

    expect(diff.ops).toEqual([
      { op: 'delete', ruleId: '800000000000000001', name: RULE_NAMES.keywords },
    ]);
  });

  test('a changed trigger is replaced, delete before create', () => {
    const desired = planNativeRules(config({ blockedWords: ['scam'] })).desired;
    const existing = parseNativeRules([raw({ trigger_type: AUTOMOD_TRIGGER_SPAM })]);

    const diff = diffNativeRules(desired, existing, BOT);
    expect(diff.ops.map((op) => op.op)).toEqual(['delete', 'create']);
  });

  test('disabling the module takes every Proton rule down and leaves the rest', () => {
    const existing = parseNativeRules([
      raw(),
      raw({ id: '900000000000000002', creator_id: ADMIN, name: 'No politics' }),
    ]);

    const diff = diffNativeRules(
      planNativeRules(config({ enabled: false })).desired,
      existing,
      BOT,
    );

    expect(diff.ops).toEqual([
      { op: 'delete', ruleId: '800000000000000001', name: RULE_NAMES.keywords },
    ]);
    expect(diff.foreign).toEqual(['No politics']);
  });
});
