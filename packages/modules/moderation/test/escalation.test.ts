import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, ruleDefinitionSchema } from '@proton/core';
import {
  ESCALATION_ACTIONS,
  moderationConfigSchema,
  moderationDefaultConfig,
} from '../src/config.ts';
import { escalationRules, moderationPresetRules } from '../src/escalation.ts';
import { moderationModule } from '../src/index.ts';

describe('warn escalation as preset rules', () => {
  test('every preset rule is a valid rule definition', () => {
    for (const rule of moderationPresetRules) {
      const result = ruleDefinitionSchema.safeParse(rule);

      expect(result.success).toBe(true);
    }
  });

  test('escalation triggers on the internal moderation.warned event', () => {
    for (const rule of moderationPresetRules) {
      expect(rule.trigger).toEqual({ kind: 'event', event: 'moderation.warned' });
    }
  });

  test('the default presets are pinned, because stored rule rows are keyed by these ids', () => {
    expect(moderationPresetRules).toEqual([
      {
        id: 'escalate-at-3',
        trigger: { kind: 'event', event: 'moderation.warned' },
        conditions: [{ kind: 'rate-over-window', limit: 3, window: '30d' }],
        actions: [
          {
            kind: 'timeout',
            reason: 'Warning 3 within 30d — automatic escalation',
            duration: '1h',
          },
        ],
        enabled: true,
        priority: 0,
      },
      {
        id: 'escalate-at-5',
        trigger: { kind: 'event', event: 'moderation.warned' },
        conditions: [{ kind: 'rate-over-window', limit: 5, window: '30d' }],
        actions: [
          {
            kind: 'timeout',
            reason: 'Warning 5 within 30d — automatic escalation',
            duration: '1d',
          },
        ],
        enabled: true,
        priority: 10,
      },
    ]);
  });

  test('one rule per rung, counting to that rung’s warning count', () => {
    const rules = escalationRules({
      escalationWindow: '7d',
      escalationLadder: [
        { atWarnings: 2, action: 'timeout', duration: '10m' },
        { atWarnings: 4, action: 'kick' },
        { atWarnings: 6, action: 'ban' },
      ],
    });

    expect(rules.map((r) => r.id)).toEqual(['escalate-at-2', 'escalate-at-4', 'escalate-at-6']);
    expect(rules.map((r) => r.conditions[0])).toEqual([
      { kind: 'rate-over-window', limit: 2, window: '7d' },
      { kind: 'rate-over-window', limit: 4, window: '7d' },
      { kind: 'rate-over-window', limit: 6, window: '7d' },
    ]);
  });

  test('a rung’s duration becomes the action’s duration', () => {
    const [rule] = escalationRules({
      escalationWindow: '30d',
      escalationLadder: [{ atWarnings: 3, action: 'timeout', duration: '1h' }],
    });

    expect(rule?.actions[0]).toMatchObject({ kind: 'timeout', duration: '1h' });
  });

  test('a rung with no duration emits no duration key at all', () => {
    const [rule] = escalationRules({
      escalationWindow: '30d',
      escalationLadder: [{ atWarnings: 3, action: 'ban' }],
    });

    expect(rule?.actions[0] && 'duration' in rule.actions[0]).toBe(false);
  });

  test('every rule names why it fired, for Discord’s own audit log', () => {
    for (const rule of moderationPresetRules) {
      expect(rule.actions[0]?.reason).toMatch(/automatic escalation/);
    }
  });

  test('priorities ascend with the ladder so ordering is deterministic', () => {
    const priorities = moderationPresetRules.map((r) => r.priority);

    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  test('each rule carries exactly one rate condition', () => {
    for (const rule of moderationPresetRules) {
      expect(rule.conditions.filter((c) => c.kind === 'rate-over-window')).toHaveLength(1);
    }
  });

  test('a guild that clears its ladder gets no escalation rules', () => {
    expect(escalationRules({ escalationWindow: '30d', escalationLadder: [] })).toEqual([]);
  });

  test('the manifest ships the compiled default ladder', () => {
    expect(moderationModule.rules).toEqual(escalationRules(moderationDefaultConfig));
  });

  test('the manifest recompiles a guild’s own ladder with the same compiler', () => {
    const config = moderationConfigSchema.parse({
      escalationWindow: '7d',
      escalationLadder: [{ atWarnings: 4, action: 'kick' }],
    });

    expect(moderationModule.compileRules?.(config)).toEqual(escalationRules(config));
  });
});

describe('moderation owns the ladder it escalates with', () => {
  test('every rung action is a kind moderation declares, so the invite asks for it', () => {
    for (const action of ESCALATION_ACTIONS) {
      expect(moderationModule.actionKinds).toContain(action);
    }
  });

  test('the rungs trigger on the event moderation itself emits', () => {
    const triggers = moderationPresetRules.flatMap((rule) =>
      rule.trigger.kind === 'event' ? [rule.trigger.event] : [],
    );

    expect(triggers).toHaveLength(moderationPresetRules.length);
    for (const event of triggers) expect(moderationModule.emits).toContain(event);
  });

  test('registers cleanly, and its generated form omits the ladder', () => {
    const registry = new ModuleRegistry();
    registry.register(moderationModule);

    const paths = registry.descriptors(moderationModule.id).map((d) => d.path);

    expect(paths).toEqual([
      'enabled',
      'requireReason',
      'publicReplies',
      'defaultTimeoutDuration',
      'defaultBanDeleteDays',
      'escalationWindow',
    ]);
    expect(paths).not.toContain('escalationLadder');
  });
});
