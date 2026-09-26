import { describe, expect, test } from 'bun:test';
import { requirementSchema, rewardSchema } from '../src/config.ts';
import { SEEN_RETENTION_MS } from '../src/constants.ts';
import { describeRequirement } from '../src/evaluate.ts';
import {
  aggregateOf,
  DEPENDENCY_LABELS,
  DEPENDENCY_MODULES,
  isTriggerId,
  LEDGER_METRICS,
  REWARD_KIND_IDS,
  REWARD_KINDS,
  STATE_METRICS,
  TRIGGER_GROUPS,
  TRIGGER_IDS,
  TRIGGERS,
  triggerOf,
} from '../src/triggers.ts';

const LEDGER = new Set<string>(LEDGER_METRICS);
const STATE = new Set<string>(STATE_METRICS);

function copyOf(trigger: (typeof TRIGGERS)[number]): string[] {
  return [
    trigger.label,
    trigger.summary,
    trigger.rule,
    ...(trigger.stateNote ? [trigger.stateNote] : []),
  ];
}

describe('the trigger catalogue', () => {
  test('lists every id once, in TRIGGER_IDS order', () => {
    expect(TRIGGERS.map((trigger) => trigger.id)).toEqual([...TRIGGER_IDS]);
    expect(new Set(TRIGGER_IDS).size).toBe(TRIGGER_IDS.length);
  });

  test('triggerOf returns the catalogue entry for each id', () => {
    for (const trigger of TRIGGERS) {
      expect(triggerOf(trigger.id)).toBe(trigger);
      expect(isTriggerId(trigger.id)).toBe(true);
    }

    expect(isTriggerId('economy.coins')).toBe(false);
    expect(isTriggerId('toString')).toBe(false);
  });

  test('state triggers read state metrics and everything else is recorded', () => {
    for (const trigger of TRIGGERS) {
      if (trigger.measurement === 'state') {
        expect(STATE.has(trigger.metric)).toBe(true);
        expect(trigger.history).toBe('state');
        expect(trigger.stateNote?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(LEDGER.has(trigger.metric)).toBe(true);
        expect(trigger.history).toBe('recorded');
        expect(trigger.stateNote).toBeUndefined();
      }
    }
  });

  test('every metric has a trigger that reads it', () => {
    const used = new Set(TRIGGERS.map((trigger) => trigger.metric));
    for (const metric of [...LEDGER_METRICS, ...STATE_METRICS]) expect(used.has(metric)).toBe(true);
  });

  test('every recorded metric has a dedupe retention', () => {
    expect(Object.keys(SEEN_RETENTION_MS).sort()).toEqual([...LEDGER_METRICS].sort());
  });

  test('only a record takes the highest value; counts and durations add up', () => {
    for (const trigger of TRIGGERS) {
      expect(aggregateOf(trigger)).toBe(trigger.measurement === 'record' ? 'max' : 'sum');
    }
    expect(aggregateOf(triggerOf('voice.longest_stay'))).toBe('max');
  });

  test('target bounds are whole, positive and ordered', () => {
    for (const trigger of TRIGGERS) {
      expect(Number.isInteger(trigger.target.min)).toBe(true);
      expect(Number.isInteger(trigger.target.max)).toBe(true);
      expect(trigger.target.min).toBeGreaterThanOrEqual(1);
      expect(trigger.target.max).toBeGreaterThanOrEqual(trigger.target.min);
    }
    expect(triggerOf('voice.longest_stay').target.max).toBe(24 * 60);
    expect(triggerOf('achievements.unlocked').target).toEqual({ min: 1, max: 1 });
  });

  test('each filter belongs to the triggers that can honour it', () => {
    const withXpSources = TRIGGERS.filter((trigger) => trigger.filters.xpSources);
    const withAchievement = TRIGGERS.filter((trigger) => trigger.filters.achievement);
    const withChannels = TRIGGERS.filter((trigger) => trigger.filters.channels).map((t) => t.id);

    expect(withXpSources.map((trigger) => trigger.id)).toEqual(['leveling.activity_xp']);
    expect(withAchievement.map((trigger) => trigger.id)).toEqual(['achievements.unlocked']);
    expect(withChannels).toEqual([
      'messages.sent',
      'voice.minutes',
      'voice.longest_stay',
      'tempvc.minutes',
      'reactions.given',
      'reactions.received',
      'starboard.messages',
    ]);
  });

  test('only temporary voice minutes are limited to temporary channels', () => {
    const temporary = TRIGGERS.filter((trigger) => trigger.temporaryOnly);
    expect(temporary.map((trigger) => trigger.id)).toEqual(['tempvc.minutes']);
    expect(triggerOf('tempvc.minutes').metric).toBe(triggerOf('voice.minutes').metric);
  });

  test('a prerequisite cannot be tiered; everything else can', () => {
    const untiered = TRIGGERS.filter((trigger) => !trigger.tiered).map((trigger) => trigger.id);
    expect(untiered).toEqual(['achievements.unlocked']);
  });

  test('a dependency is the module the trigger comes from', () => {
    for (const trigger of TRIGGERS) {
      if (trigger.dependsOn === null) {
        expect(['discord', 'achievements']).toContain(trigger.sourceModule);
      } else {
        expect(trigger.sourceModule).toBe(trigger.dependsOn);
        expect(DEPENDENCY_LABELS[trigger.dependsOn].length).toBeGreaterThan(0);
      }
    }
    expect(DEPENDENCY_MODULES.every((module) => module in DEPENDENCY_LABELS)).toBe(true);
  });

  test('voice triggers never claim a current channel', () => {
    for (const id of ['voice.minutes', 'voice.longest_stay', 'tempvc.minutes'] as const) {
      expect(triggerOf(id).originChannel).toBe(false);
    }
    expect(triggerOf('messages.sent').originChannel).toBe(true);
  });

  test('accepted applications count from Applications and never announce in a channel', () => {
    const trigger = triggerOf('applications.accepted');

    expect(trigger).toMatchObject({
      group: 'Applications',
      sourceModule: 'applications',
      dependsOn: 'applications',
      measurement: 'count',
      metric: 'applications_accepted',
      history: 'recorded',
      tiered: true,
      originChannel: false,
    });
    expect(trigger.filters).toEqual({ channels: false, xpSources: false, achievement: false });
    expect(DEPENDENCY_LABELS.applications).toBe('Applications');
    expect(SEEN_RETENTION_MS.applications_accepted).toBeNull();

    const requirement = requirementSchema.parse({ id: 'r1', trigger: 'applications.accepted' });
    expect(describeRequirement(requirement, 1)).toBe('Get 1 application accepted');
    expect(describeRequirement(requirement, 5)).toBe('Get 5 applications accepted');
  });

  test('every group is used and every trigger sits in a known group', () => {
    const groups = new Set(TRIGGERS.map((trigger) => trigger.group));
    expect([...groups].sort()).toEqual([...TRIGGER_GROUPS].sort());
  });

  test('copy uses curly apostrophes, no exclamation marks and no em dashes', () => {
    for (const trigger of TRIGGERS) {
      for (const text of copyOf(trigger)) {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain("'");
        expect(text).not.toContain('"');
        expect(text).not.toContain('!');
        expect(text).not.toContain('—');
      }
      expect(trigger.unit.one.length).toBeGreaterThan(0);
      expect(trigger.unit.many.length).toBeGreaterThan(0);
    }
  });

  test('rule texts carry the limits the collectors enforce', () => {
    expect(triggerOf('reactions.given').rule).toContain('at most 50 a day');
    expect(triggerOf('reactions.given').rule).toContain('under 7 days old');
    expect(triggerOf('reactions.received').rule).toContain('at most 5 a day');
    expect(triggerOf('activity.active_days').rule).toContain('module’s time zone');
  });

  test('reward kinds match the reward schema, and only XP needs Leveling', () => {
    expect(REWARD_KINDS.map((kind) => kind.kind)).toEqual([...REWARD_KIND_IDS]);
    expect(REWARD_KINDS.filter((kind) => kind.dependsOn).map((kind) => kind.kind)).toEqual(['xp']);

    for (const kind of REWARD_KIND_IDS) {
      const sample = kind === 'xp' ? { kind, amount: 10 } : { kind, roleId: '100000000000000001' };
      expect(rewardSchema.safeParse(sample).success).toBe(true);
    }

    expect(rewardSchema.safeParse({ kind: 'coins', amount: 10 }).success).toBe(false);
  });
});
