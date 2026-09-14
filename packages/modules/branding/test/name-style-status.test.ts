import { describe, expect, test } from 'bun:test';
import type { BotNameStyle, NameStyleState } from '@proton/core';
import type { DisplayNameStyle } from '../src/name-style.ts';
import {
  describeNameStyleStatus,
  fromWireStyle,
  type NameStyleStatus,
  nameStyleStatusSchema,
} from '../src/name-style-status.ts';

const GUILD = '900000000000000001';
const AT = 1_787_000_000_000;

const GRADIENT: DisplayNameStyle = {
  font: 'modern',
  effect: 'gradient',
  colours: [0x5865f2, 0xeb459e],
};
const GRADIENT_WIRE: BotNameStyle = { fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] };
const NEON_WIRE: BotNameStyle = { fontId: 12, effectId: 3, colours: [0xff0000] };

function state(overrides: Partial<NameStyleState> = {}): NameStyleState {
  return {
    guildId: GUILD,
    requested: GRADIENT_WIRE,
    outcome: 'confirmed',
    reason: null,
    attemptedAt: AT,
    confirmed: GRADIENT_WIRE,
    confirmedAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const produced: NameStyleStatus[] = [];

function status(
  requested: DisplayNameStyle | null,
  held: NameStyleState | null,
  enabled = true,
): NameStyleStatus {
  const answer = describeNameStyleStatus({ enabled, requested, state: held });
  produced.push(answer);
  return answer;
}

function headline(answer: NameStyleStatus): [string, string | null] {
  return [answer.state, answer.reason];
}

describe('the status of a display name style', () => {
  test('is unavailable for a style Discord does not offer for apps, even with Branding off', () => {
    for (const requested of [
      { font: 'monkey-bars', effect: 'solid', colours: [0] },
      { font: 'modern', effect: 'prism', colours: [1, 2, 3, 4, 5] },
      { font: 'modern', effect: 'gradient', colours: [1] },
    ] as const satisfies readonly DisplayNameStyle[]) {
      const copy: DisplayNameStyle = { ...requested, colours: [...requested.colours] };

      expect(headline(status(copy, state()))).toEqual(['unavailable', null]);
      expect(headline(status(copy, null, false))).toEqual(['unavailable', null]);
    }
  });

  test('is off while Branding is switched off', () => {
    expect(headline(status(GRADIENT, state(), false))).toEqual(['off', null]);
    expect(headline(status(null, null, false))).toEqual(['off', null]);
  });

  test('is none for no style when Proton never styled the server', () => {
    expect(headline(status(null, null))).toEqual(['none', null]);
  });

  test('is applying until the worker records an attempt for this exact request', () => {
    expect(headline(status(GRADIENT, null))).toEqual(['applying', null]);
    expect(headline(status(GRADIENT, state({ requested: NEON_WIRE })))).toEqual(['applying', null]);
    expect(headline(status(null, state()))).toEqual(['applying', null]);
    expect(headline(status({ ...GRADIENT, colours: [0xeb459e, 0x5865f2] }, state()))).toEqual([
      'applying',
      null,
    ]);
  });

  test('is applied once Discord confirmed the request, no style included', () => {
    expect(headline(status(GRADIENT, state()))).toEqual(['applied', null]);
    expect(headline(status(null, state({ requested: null, confirmed: null })))).toEqual([
      'applied',
      null,
    ]);
  });

  test('reads a confirmed outcome with no confirmed time as unverified', () => {
    expect(headline(status(GRADIENT, state({ confirmedAt: null })))).toEqual(['unverified', null]);
  });

  test('carries the reason for an ignored, rejected or unverified attempt', () => {
    for (const [outcome, reason] of [
      ['ignored', 'discord_ignored'],
      ['rejected', 'missing_change_nickname'],
      ['rejected', 'discord_refused'],
      ['unverified', 'no_answer'],
      ['unverified', 'not_readable'],
      ['unverified', 'changed_in_discord'],
    ] as const) {
      expect(headline(status(GRADIENT, state({ outcome, reason })))).toEqual([outcome, reason]);
    }
  });

  test('describes the last attempt and the confirmed style in catalogue terms', () => {
    const answer = status(
      GRADIENT,
      state({
        requested: GRADIENT_WIRE,
        outcome: 'ignored',
        reason: 'discord_ignored',
        attemptedAt: AT + 5,
        confirmed: NEON_WIRE,
        confirmedAt: AT,
        updatedAt: AT + 5,
      }),
    );

    expect(answer).toEqual({
      state: 'ignored',
      reason: 'discord_ignored',
      requested: GRADIENT,
      lastAttempt: {
        style: { ...GRADIENT_WIRE, font: 'modern', effect: 'gradient' },
        outcome: 'ignored',
        reason: 'discord_ignored',
        attemptedAt: AT + 5,
        updatedAt: AT + 5,
      },
      confirmed: {
        style: { ...NEON_WIRE, font: 'tempo', effect: 'neon' },
        confirmedAt: AT,
      },
    });
  });

  test('leaves confirmed empty when nothing is confirmed, and both empty with no record', () => {
    expect(status(GRADIENT, state({ confirmedAt: null })).confirmed).toBeNull();
    expect(status(GRADIENT, null)).toMatchObject({ lastAttempt: null, confirmed: null });
    expect(status(null, state({ requested: null, confirmed: null })).confirmed).toEqual({
      style: null,
      confirmedAt: AT,
    });
  });

  test('parses every answer with the response schema', () => {
    expect(produced.length).toBeGreaterThan(10);
    for (const answer of produced) {
      expect(nameStyleStatusSchema.parse(answer)).toEqual(answer);
    }
  });
});

describe('describing a style Discord holds', () => {
  test('names catalogue ids, and leaves an id Proton does not know unnamed', () => {
    expect(fromWireStyle({ fontId: 13, effectId: 7, colours: [1, 2, 3, 4, 5] })).toEqual({
      fontId: 13,
      effectId: 7,
      colours: [1, 2, 3, 4, 5],
      font: 'monkey-bars',
      effect: 'prism',
    });
    expect(fromWireStyle({ fontId: 1, effectId: 6, colours: [] })).toEqual({
      fontId: 1,
      effectId: 6,
      colours: [],
      font: null,
      effect: null,
    });
    expect(fromWireStyle(null)).toBeNull();
  });
});

describe('the status module', () => {
  test('imports nothing but zod, core and the catalogue, so the dashboard can load it', async () => {
    const source = await Bun.file(new URL('../src/name-style-status.ts', import.meta.url)).text();
    const sources = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(sources.sort()).toEqual(['./name-style.ts', '@proton/core', 'zod']);
  });
});
