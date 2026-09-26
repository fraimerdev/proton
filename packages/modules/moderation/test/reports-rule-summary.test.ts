import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import { type ModerationConfig, moderationConfigSchema } from '../src/config.ts';
import {
  type AutomationRule,
  type automationRuleSchema,
  DEFAULT_STAFF_ALERT,
} from '../src/reports/config.ts';
import {
  describeRule,
  durationWords,
  joinWords,
  type RuleNames,
} from '../src/reports/rule-summary.ts';

const REPORT_CHANNEL = '500000000000000009';
const LOG_CHANNEL = '500000000000000010';
const MODS = '410000000000000004';
const ADMINS = '410000000000000009';
const MUTED = '410000000000000002';

const NAMES: RuleNames = {
  channel: (id) => ({ [REPORT_CHANNEL]: 'reports', [LOG_CHANNEL]: 'mod-log' })[id] ?? null,
  role: (id) => ({ [MODS]: 'Mods', [ADMINS]: 'Admins', [MUTED]: 'Muted' })[id] ?? null,
};

const ALERT = { kind: 'alert' as const, roleIds: [], message: DEFAULT_STAFF_ALERT };

function config(input: z.input<typeof moderationConfigSchema> = {}): ModerationConfig {
  return moderationConfigSchema.parse({
    ...input,
    reports: { channelId: REPORT_CHANNEL, ...input.reports },
  });
}

function rule(input: Partial<z.input<typeof automationRuleSchema>> = {}): AutomationRule {
  const [parsed] = config({
    reports: {
      automation: [
        { id: 'r', name: 'Rule', conditions: { reporters: 3 }, actions: [ALERT], ...input },
      ],
    },
  }).reports.automation;
  if (!parsed) throw new Error('the rule did not parse');
  return parsed;
}

describe('describeRule', () => {
  test('the default rule reads as the dashboard shows it', () => {
    const [defaultRule] = config().reports.automation;
    if (!defaultRule) throw new Error('no default rule');

    expect(describeRule(defaultRule, config(), NAMES)).toBe(
      'When 3 different members report the same person within 24 hours (open or in review), ' +
        'post an alert in #reports.',
    );
    expect(describeRule(defaultRule, config())).toBe(
      'When 3 different members report the same person within 24 hours (open or in review), ' +
        'post an alert in the report channel.',
    );
  });

  test('all joins conditions with and, any with or', () => {
    const conditions = { reports: 5, reporters: 3 };

    expect(describeRule(rule({ conditions, match: 'all' }), config(), NAMES)).toBe(
      'When 3 different members report the same person and they are reported 5 times within ' +
        '24 hours (open or in review), post an alert in #reports.',
    );
    expect(describeRule(rule({ conditions, match: 'any' }), config(), NAMES)).toBe(
      'When 3 different members report the same person or the same person is reported 5 times ' +
        'within 24 hours (open or in review), post an alert in #reports.',
    );
  });

  test('a time condition names the wait and the window', () => {
    expect(
      describeRule(
        rule({ conditions: { unreviewedFor: '2h' }, statuses: ['open'] }),
        config(),
        NAMES,
      ),
    ).toBe(
      'When a report filed in the last 24 hours stays open and unclaimed for 2 hours (open), ' +
        'post an alert in #reports.',
    );
    expect(
      describeRule(
        rule({ conditions: { reporters: 2, unreviewedFor: '30m' }, window: '7d' }),
        config(),
        NAMES,
      ),
    ).toBe(
      'When 2 different members report the same person within 7 days and a report about them ' +
        'stays open and unclaimed for 30 minutes (open or in review), post an alert in #reports.',
    );
  });

  test('punishing rules say what they do and carry the risk warning', () => {
    const text = describeRule(
      rule({
        conditions: { reporters: 5 },
        window: '1h',
        actions: [
          { ...ALERT, channelId: LOG_CHANNEL, roleIds: [MODS, ADMINS] },
          { kind: 'punish', punishment: 'timeout', reason: 'Reported' },
          { kind: 'add_role', roleId: MUTED },
        ],
      }),
      config(),
      NAMES,
    );

    expect(text).toBe(
      'When 5 different members report the same person within 1 hour (open or in review), ' +
        'post an alert in #mod-log mentioning @Mods and @Admins, time them out for 1 hour and ' +
        'give them @Muted. Proton does this before anyone reviews the reports, so a group of ' +
        'false reports is enough to get someone timed out. Confirm that you understand this ' +
        'risk before saving.',
    );
  });

  test('an acknowledged risk drops the confirmation, not the warning', () => {
    const text = describeRule(
      rule({
        actions: [{ kind: 'punish', punishment: 'ban', reason: 'Reported' }],
        acknowledgedRisk: true,
      }),
      config(),
    );

    expect(text).toContain('ban them permanently.');
    expect(text).toContain('enough to get someone banned.');
    expect(text).not.toContain('Confirm');
  });

  test('bans follow the server default length when the rule sets none', () => {
    const text = describeRule(
      rule({ actions: [{ kind: 'punish', punishment: 'ban', reason: 'Reported' }] }),
      config({ punish: { types: { ban: { defaultDuration: '7d' } } } }),
    );

    expect(text).toContain('ban them for 7 days.');
  });

  test('messages, removed roles and unknown names read plainly', () => {
    const text = describeRule(
      rule({
        actions: [
          { kind: 'dm', message: { content: 'Hello' } },
          { kind: 'remove_role', roleId: '410000000000000099' },
          { ...ALERT, channelId: '500000000000000099', roleIds: [MODS, '410000000000000098'] },
        ],
      }),
      config(),
      NAMES,
    );

    expect(text).toBe(
      'When 3 different members report the same person within 24 hours (open or in review), ' +
        'DM the reported member, take the chosen role away from them and post an alert in the ' +
        'chosen channel mentioning 2 chosen roles.',
    );
  });

  test('rules that cannot run say so', () => {
    expect(describeRule(rule({ conditions: {} }), config())).toBe(
      'This rule has no condition, so it never runs.',
    );
    expect(describeRule(rule({ actions: [] }), config())).toBe(
      'When 3 different members report the same person within 24 hours (open or in review), ' +
        'nothing happens yet. Add an action.',
    );
    expect(describeRule(rule({ enabled: false }), config())).toMatch(/The rule is off\.$/);
    expect(
      describeRule(
        rule({ conditions: { reports: 2, unreviewedFor: '1h' }, statuses: ['in_review'] }),
        config(),
      ),
    ).toContain('Its unclaimed-for condition never applies');
    expect(
      describeRule(rule({ statuses: ['open', 'in_review', 'accepted', 'dismissed'] }), config()),
    ).toContain('(any status)');
  });
});

describe('the wording helpers', () => {
  test('durations read as words', () => {
    expect(durationWords('24h')).toBe('24 hours');
    expect(durationWords('1d')).toBe('1 day');
    expect(durationWords('2w')).toBe('2 weeks');
    expect(durationWords('45s')).toBe('45 seconds');
    expect(durationWords('soon')).toBe('soon');
  });

  test('lists join the way a sentence does', () => {
    expect(joinWords([], 'and')).toBe('');
    expect(joinWords(['a'], 'and')).toBe('a');
    expect(joinWords(['a', 'b'], 'or')).toBe('a or b');
    expect(joinWords(['a', 'b', 'c'], 'and')).toBe('a, b and c');
  });
});
