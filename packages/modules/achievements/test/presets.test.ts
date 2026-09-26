import { describe, expect, test } from 'bun:test';
import { achievementsConfigSchema } from '../src/config.ts';
import {
  ALL_ROUNDER_XP,
  instantiatePreset,
  PRESET_IDS,
  PRESETS,
  presetDependencies,
  presetNeedsRole,
} from '../src/presets.ts';
import { triggerOf } from '../src/triggers.ts';
import { validateConfig } from '../src/validate.ts';

const ROLE = '400000000000000021';
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const EMPTY = achievementsConfigSchema.parse({});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('presets', () => {
  test('every preset has metadata, in PRESET_IDS order', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([...PRESET_IDS]);

    for (const preset of PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.description).not.toContain("'");
      expect(preset.dependsOn).toEqual(presetDependencies(preset.id));
      expect(preset.needsRole).toBe(presetNeedsRole(preset.id));
    }
  });

  test('Community Regular says which time zone draws the day', () => {
    const community = PRESETS.find((preset) => preset.id === 'community_regular');
    expect(community?.description).toContain('module’s time zone');
  });

  for (const id of PRESET_IDS) {
    test(`${id} instantiates to a draft that parses and validates clean`, () => {
      const achievement = instantiatePreset(id, { random: seeded(7), roleId: ROLE });
      const config = achievementsConfigSchema.parse({ achievements: [achievement] });

      expect(config.achievements[0]).toEqual(achievement);
      expect(achievement.status).toBe('draft');
      expect(validateConfig(config, EMPTY, NOW)).toEqual([]);

      const expected = PRESETS.find((preset) => preset.id === id);
      expect(achievement.kind).toBe(expected?.kind ?? 'single');
    });
  }

  test('all presets together make one valid config', () => {
    const random = seeded(42);
    const achievements = PRESET_IDS.map((id) => instantiatePreset(id, { random, roleId: ROLE }));
    const config = achievementsConfigSchema.parse({ achievements });

    expect(new Set(achievements.map((achievement) => achievement.id)).size).toBe(PRESET_IDS.length);
    expect(validateConfig(config, EMPTY, NOW)).toEqual([]);
  });

  test('requirement ids stay distinct even when the random source repeats', () => {
    const achievement = instantiatePreset('all_rounder', { random: () => 0.5, roleId: ROLE });
    const ids = achievement.requirements.map((requirement) => requirement.id);
    expect(new Set(ids).size).toBe(3);

    const config = achievementsConfigSchema.parse({ achievements: [achievement] });
    expect(validateConfig(config, EMPTY, NOW)).toEqual([]);
  });

  test('only All-Rounder needs a role, and it refuses to start without one', () => {
    expect(PRESET_IDS.filter(presetNeedsRole)).toEqual(['all_rounder']);
    expect(() => instantiatePreset('all_rounder', { random: seeded(1) })).toThrow(
      'All-Rounder gives a role, so pick the role before creating it.',
    );
  });

  test('All-Rounder combines messages, voice and a level, with the role and 250 XP', () => {
    const achievement = instantiatePreset('all_rounder', { random: seeded(3), roleId: ROLE });

    expect(achievement.kind).toBe('single');
    expect(achievement.requirements.map((requirement) => requirement.trigger)).toEqual([
      'messages.sent',
      'voice.minutes',
      'leveling.level',
    ]);

    const [tier] = achievement.tiers;
    expect(tier?.id).toBe('single');
    expect(achievement.requirements.map((requirement) => tier?.targets[requirement.id])).toEqual([
      100, 60, 5,
    ]);
    expect(tier?.rewards).toEqual([
      { kind: 'add_role', roleId: ROLE },
      { kind: 'xp', amount: ALL_ROUNDER_XP },
    ]);
    expect(presetDependencies('all_rounder')).toEqual(['leveling']);
  });

  test('tiered presets climb Bronze to Diamond without rewards', () => {
    const achievement = instantiatePreset('conversation_starter', { random: seeded(9) });
    const [requirement] = achievement.requirements;

    expect(achievement.tiers.map((tier) => tier.id)).toEqual([
      'bronze',
      'silver',
      'gold',
      'diamond',
    ]);
    expect(achievement.tiers.map((tier) => tier.targets[requirement?.id ?? ''])).toEqual([
      50, 250, 1000, 5000,
    ]);
    expect(achievement.tiers.every((tier) => tier.rewards.length === 0)).toBe(true);
  });

  test('dependencies follow the triggers each preset uses', () => {
    for (const id of PRESET_IDS) {
      const achievement = instantiatePreset(id, { random: seeded(5), roleId: ROLE });
      const fromTriggers = achievement.requirements
        .map((requirement) => triggerOf(requirement.trigger).dependsOn)
        .filter((module) => module !== null);

      for (const module of fromTriggers) expect(presetDependencies(id)).toContain(module);
    }

    expect(presetDependencies('star_contributor')).toEqual(['starboard']);
    expect(presetDependencies('conversation_starter')).toEqual([]);
  });
});
