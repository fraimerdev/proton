import { describe, expect, test } from 'bun:test';
import {
  simulationAttachmentSchema,
  simulationCardQuery,
  simulationCardSchema,
} from '../../src/simulation/types.ts';

describe('simulationCardSchema', () => {
  test('a badge needs no display name, because it pictures no member', () => {
    const parsed = simulationCardSchema.parse({
      kind: 'badge',
      shape: 'shield',
      colour: 0xd9a931,
      icon: 'trophy',
    });

    expect(parsed).toEqual({ kind: 'badge', shape: 'shield', colour: 0xd9a931, icon: 'trophy' });
  });

  test('a member card still needs one', () => {
    expect(simulationCardSchema.safeParse({ kind: 'rank' }).success).toBe(false);
    expect(simulationCardSchema.safeParse({ kind: 'rank', displayName: 'Fraimer' }).success).toBe(
      true,
    );
  });

  test('a badge colour is the resolved integer, never the word tier', () => {
    expect(
      simulationCardSchema.safeParse({ kind: 'badge', shape: 'circle', colour: 'tier' }).success,
    ).toBe(false);
  });

  test('refuses an asset id the upload route could not have issued', () => {
    const card = { kind: 'badge', shape: 'circle', colour: 0 };

    expect(simulationCardSchema.safeParse({ ...card, assetId: '../etc' }).success).toBe(false);
    expect(simulationCardSchema.safeParse({ ...card, assetId: 'a1b2c3d4e5' }).success).toBe(true);
  });

  test('an attachment carries either branch', () => {
    const badge = { filename: 'badge.png', card: { kind: 'badge', shape: 'hexagon', colour: 1 } };

    expect(simulationAttachmentSchema.safeParse(badge).success).toBe(true);
  });
});

describe('simulationCardQuery', () => {
  test('writes a badge as the preview route reads it', () => {
    const query = new URLSearchParams(
      simulationCardQuery({
        kind: 'badge',
        shape: 'square',
        colour: 0x2a8af7,
        icon: 'star',
        assetId: 'a1b2c3d4e5',
      }),
    );

    expect(Object.fromEntries(query)).toEqual({
      kind: 'badge',
      shape: 'square',
      colour: String(0x2a8af7),
      icon: 'star',
      assetId: 'a1b2c3d4e5',
    });
  });

  test('leaves out what the card does not set', () => {
    const query = new URLSearchParams(
      simulationCardQuery({ kind: 'welcome', displayName: 'Fraimer', memberCount: 12 }),
    );

    expect(Object.fromEntries(query)).toEqual({
      kind: 'welcome',
      displayName: 'Fraimer',
      memberCount: '12',
    });
  });
});
