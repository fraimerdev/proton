import { describe, expect, test } from 'bun:test';
import type { GuildState } from '@proton/core';
import {
  CHANNEL_NAME_MAX,
  COUNTERS_CEILING,
  type CountersConfig,
  countersConfigSchema,
  countersDefaultConfig,
  countersFormSchema,
  TEMPLATE_MAX,
} from '../src/config.ts';
import { countFor, plan, renderName, renderReport } from '../src/render.ts';
import { COUNTER_A, COUNTER_B, EVERYONE_ROLE, guildState, MEMBER_COUNT } from './harness.ts';

function config(counters: CountersConfig['counters']): CountersConfig {
  return { ...countersDefaultConfig, enabled: true, counters };
}

describe('renderName', () => {
  test('puts the number where {count} is', () => {
    expect(renderName('Members: {count}', 1234)).toBe('Members: 1234');
  });

  test('substitutes every occurrence, not just the first', () => {
    expect(renderName('{count} of {count}', 7)).toBe('7 of 7');
  });

  test('leaves a placeholder it does not know alone rather than rendering undefined', () => {
    expect(renderName('{members} online — {count}', 3)).toBe('{members} online — 3');
  });

  test('renders zero as zero rather than as nothing', () => {
    expect(renderName('Members: {count}', 0)).toBe('Members: 0');
  });

  test('a template with no {count} comes back unchanged', () => {
    expect(renderName('Nothing here', 9)).toBe('Nothing here');
  });

  test('never exceeds the channel-name cap Discord enforces', () => {
    expect(renderName(`${'x'.repeat(CHANNEL_NAME_MAX)}{count}`, 5)).toHaveLength(CHANNEL_NAME_MAX);
  });

  test('a template at its own maximum still fits once the number is in it', () => {
    const template = `${'x'.repeat(TEMPLATE_MAX - '{count}'.length)}{count}`;

    expect(renderName(template, 999_999_999).length).toBeLessThanOrEqual(CHANNEL_NAME_MAX);
  });
});

describe('countFor', () => {
  test('members reads the cached member count', () => {
    expect(countFor('members', guildState())).toBe(MEMBER_COUNT);
  });

  test('members is unavailable rather than zero when the snapshot has no count', () => {
    const state: GuildState = { ...guildState() };
    delete state.memberCount;

    expect(countFor('members', state)).toBeNull();
  });

  test('roles leaves out @everyone, which no admin counts as a role', () => {
    const state = guildState();

    expect(state.roles.has(EVERYONE_ROLE)).toBe(true);
    expect(countFor('roles', state)).toBe(state.roles.size - 1);
  });

  test('channels leaves out categories and threads', () => {
    const state = guildState();
    const countable = countFor('channels', state);

    state.channels.set('700000000000000001', {
      id: '700000000000000001',
      parentId: null,
      type: 4,
      name: 'Information',
      overwrites: [],
    });
    state.channels.set('700000000000000002', {
      id: '700000000000000002',
      parentId: null,
      type: 11,
      name: 'a thread',
      overwrites: [],
    });

    expect(countFor('channels', state)).toBe(countable);
  });

  test('counts a channel whose type the snapshot never recorded', () => {
    const state = guildState();
    const before = countFor('channels', state) ?? 0;

    state.channels.set('700000000000000003', {
      id: '700000000000000003',
      parentId: null,
      name: 'unknown kind',
      overwrites: [],
    });

    expect(countFor('channels', state)).toBe(before + 1);
  });
});

describe('plan', () => {
  test('filters out a counter already showing the right name', () => {
    const state = guildState();
    state.channels.set(COUNTER_A, {
      ...(state.channels.get(COUNTER_A) as { id: string; parentId: null; overwrites: [] }),
      name: `Members: ${MEMBER_COUNT}`,
    });

    const result = plan(
      config([{ channelId: COUNTER_A, template: 'Members: {count}', source: 'members' }]),
      state,
    );

    expect(result.edits).toEqual([]);
    expect(result.unchanged).toEqual([COUNTER_A]);
  });

  test('renames a counter whose number has moved, and says what it is moving from', () => {
    const result = plan(
      config([{ channelId: COUNTER_A, template: 'Members: {count}', source: 'members' }]),
      guildState(),
    );

    expect(result.edits).toEqual([
      { channelId: COUNTER_A, from: 'Members: 0', to: `Members: ${MEMBER_COUNT}` },
    ]);
  });

  test('writes a channel this snapshot has never seen rather than assuming it is correct', () => {
    const state = guildState();
    state.channels.delete(COUNTER_A);

    const result = plan(
      config([{ channelId: COUNTER_A, template: 'Members: {count}', source: 'members' }]),
      state,
    );

    expect(result.edits).toEqual([
      { channelId: COUNTER_A, from: null, to: `Members: ${MEMBER_COUNT}` },
    ]);
  });

  test('skips a counter whose figure this snapshot does not carry', () => {
    const state: GuildState = { ...guildState() };
    delete state.memberCount;

    const result = plan(
      config([{ channelId: COUNTER_A, template: 'Members: {count}', source: 'members' }]),
      state,
    );

    expect(result).toEqual({ edits: [], unchanged: [], unavailable: [COUNTER_A] });
  });

  test('plans each counter independently', () => {
    const state = guildState();
    state.channels.set(COUNTER_B, {
      ...(state.channels.get(COUNTER_B) as { id: string; parentId: null; overwrites: [] }),
      name: `Roles: ${state.roles.size - 1}`,
    });

    const result = plan(
      config([
        { channelId: COUNTER_A, template: 'Members: {count}', source: 'members' },
        { channelId: COUNTER_B, template: 'Roles: {count}', source: 'roles' },
      ]),
      state,
    );

    expect(result.edits.map((edit) => edit.channelId)).toEqual([COUNTER_A]);
    expect(result.unchanged).toEqual([COUNTER_B]);
  });

  test('an empty counter list plans nothing', () => {
    expect(plan(config([]), guildState())).toEqual({ edits: [], unchanged: [], unavailable: [] });
  });
});

describe('renderReport', () => {
  test('reports what changed and what was already correct', () => {
    const text = renderReport({
      total: 3,
      updated: 1,
      unchanged: 2,
      unavailable: 0,
      failures: [],
    });

    expect(text).toContain('3 counter channels');
    expect(text).toContain('1 renamed');
    expect(text).toContain('2 already correct');
  });

  test('counts one channel in the singular', () => {
    const text = renderReport({ total: 1, updated: 0, unchanged: 1, unavailable: 0, failures: [] });

    expect(text).toContain('1 counter channel —');
  });

  test('explains a skip instead of hiding it', () => {
    const text = renderReport({ total: 1, updated: 0, unchanged: 0, unavailable: 1, failures: [] });

    expect(text).toContain('1 skipped');
    expect(text).toContain('member count');
  });

  test('names the channel and the reason for every refusal', () => {
    const text = renderReport({
      total: 1,
      updated: 0,
      unchanged: 0,
      unavailable: 0,
      failures: [
        { channelId: COUNTER_A, humanReason: "I'm missing the ManageChannels permission." },
      ],
    });

    expect(text).toContain(`<#${COUNTER_A}>`);
    expect(text).toContain('ManageChannels');
  });

  test('says a server has none rather than reporting zero of zero', () => {
    expect(
      renderReport({ total: 0, updated: 0, unchanged: 0, unavailable: 0, failures: [] }),
    ).toContain('No counter channels are set up');
  });
});

describe('countersConfigSchema', () => {
  test('defaults leave the module off with nothing configured', () => {
    expect(countersConfigSchema.parse({})).toEqual({ enabled: false, counters: [] });
  });

  test('refuses a template with no {count} and says why', () => {
    const result = countersConfigSchema.safeParse({
      counters: [{ channelId: COUNTER_A, template: 'Members', source: 'members' }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('{count}');
  });

  test('refuses a template longer than the cap', () => {
    const result = countersConfigSchema.safeParse({
      counters: [
        { channelId: COUNTER_A, template: `{count}${'x'.repeat(TEMPLATE_MAX)}`, source: 'members' },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('refuses a source it cannot actually read', () => {
    const result = countersConfigSchema.safeParse({
      counters: [{ channelId: COUNTER_A, template: '{count}', source: 'bots' }],
    });

    expect(result.success).toBe(false);
  });

  test('refuses two counters on the same channel', () => {
    const result = countersConfigSchema.safeParse({
      counters: [
        { channelId: COUNTER_A, template: 'Members: {count}', source: 'members' },
        { channelId: COUNTER_A, template: 'Roles: {count}', source: 'roles' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('cannot share a channel');
  });

  test('caps the list at the highest tier’s allowance', () => {
    const one = { channelId: COUNTER_A, template: '{count}', source: 'members' as const };

    expect(
      countersConfigSchema.safeParse({
        counters: Array.from({ length: COUNTERS_CEILING + 1 }, (_, index) => ({
          ...one,
          channelId: String(600000000000000000n + BigInt(index)),
        })),
      }).success,
    ).toBe(false);
  });

  test('the form schema omits the list the generator cannot draw', () => {
    expect(Object.keys(countersFormSchema.shape)).toEqual(['enabled']);
  });
});
