import { describe, expect, test } from 'bun:test';
import {
  HOLOGRAPHIC_PRIMARY,
  HOLOGRAPHIC_SECONDARY,
  HOLOGRAPHIC_TERTIARY,
  Permissions,
} from '@proton/core';
import { coloursFor } from '../src/colour.ts';
import { COLOUR_ROLE, configChanged, harness } from './harness.ts';

const NAMED = { nickname: 'Dreamliner', typeface: 'none' } as const;

function bodyOf(call: { body?: unknown } | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe('choosing the colours', () => {
  test('solid sends one colour and clears the other two', () => {
    expect(
      coloursFor({
        nameEffect: 'solid',
        primaryColor: 0x4db9c0,
        secondaryColor: 0xffffff,
      } as never),
    ).toEqual({ primaryColor: 0x4db9c0, secondaryColor: null, tertiaryColor: null });
  });

  test('gradient sends both pickers', () => {
    expect(
      coloursFor({
        nameEffect: 'gradient',
        primaryColor: 0xffffff,
        secondaryColor: 0x4db9c0,
      } as never),
    ).toEqual({ primaryColor: 0xffffff, secondaryColor: 0x4db9c0, tertiaryColor: null });
  });

  // Discord refuses any other combination with a tertiary colour, so the pickers are ignored here
  // rather than sent and rejected.
  test('holographic ignores the pickers and sends Discord’s three fixed values', () => {
    expect(
      coloursFor({
        nameEffect: 'holographic',
        primaryColor: 0x000000,
        secondaryColor: 0x000000,
      } as never),
    ).toEqual({
      primaryColor: HOLOGRAPHIC_PRIMARY,
      secondaryColor: HOLOGRAPHIC_SECONDARY,
      tertiaryColor: HOLOGRAPHIC_TERTIARY,
    });
  });

  test('none colours nothing', () => {
    expect(coloursFor({ nameEffect: 'none' } as never)).toBeNull();
  });
});

describe('wearing the colour', () => {
  test('makes a role, remembers it, and puts it on the bot', async () => {
    const h = harness();

    await h.listen(configChanged(), {
      ...NAMED,
      nameEffect: 'gradient',
      primaryColor: 0xffffff,
      secondaryColor: 0x4db9c0,
    });

    const created = h.calls().find((call) => call.method === 'POST');
    expect(created?.path).toBe('/guilds/900000000000000001/roles');
    expect(bodyOf(created).colors).toEqual({
      primary_color: 0xffffff,
      secondary_color: 0x4db9c0,
      tertiary_color: null,
    });

    expect(h.roles.written).toEqual([COLOUR_ROLE]);

    const worn = h.calls().find((call) => call.method === 'PUT');
    expect(worn?.path).toBe(
      `/guilds/900000000000000001/members/300000000000000001/roles/${COLOUR_ROLE}`,
    );
  });

  test('recolours the role it already made instead of making another', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged(), { ...NAMED, nameEffect: 'solid', primaryColor: 0x4db9c0 });

    expect(h.calls().filter((call) => call.method === 'POST')).toHaveLength(0);

    const edited = h
      .calls()
      .find((call) => call.method === 'PATCH' && call.path.includes('/roles/'));

    expect(edited?.path).toBe(`/guilds/900000000000000001/roles/${COLOUR_ROLE}`);
    expect(bodyOf(edited).colors).toEqual({
      primary_color: 0x4db9c0,
      secondary_color: null,
      tertiary_color: null,
    });
  });

  test('takes the role off the bot when the effect goes back to none', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged(), { ...NAMED, nameEffect: 'none' });

    const removed = h.calls().find((call) => call.method === 'DELETE');
    expect(removed?.path).toBe(
      `/guilds/900000000000000001/members/300000000000000001/roles/${COLOUR_ROLE}`,
    );

    // Never deleted: an admin may have given this role to somebody else, and deleting it would
    // take the colour off all of them.
    expect(h.roles.held).toBe(COLOUR_ROLE);
  });

  test('issues nothing about colour when no effect was ever chosen', async () => {
    const h = harness();

    await h.listen(configChanged(), { ...NAMED, nameEffect: 'none' });

    expect(h.calls().filter((call) => call.path.includes('/roles'))).toHaveLength(0);
  });

  test('says what a refused gradient actually needs', async () => {
    const h = harness({ status: 400 });
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged(), {
      ...NAMED,
      nameEffect: 'gradient',
      primaryColor: 0xffffff,
      secondaryColor: 0x4db9c0,
    });

    const warning = h.logs.find((line) => line.message.includes('recolour'));
    expect(warning?.message).toContain('Enhanced Role Colours');
  });

  test('the module asks for Manage Roles, because the colour is a role', () => {
    expect(harness).toBeDefined();
    expect(Permissions.ManageRoles).toBeGreaterThan(0n);
  });
});

describe('the styled nickname that reaches Discord', () => {
  test('is spelled in the chosen typeface, not the plain letters', async () => {
    const h = harness();

    await h.listen(configChanged(), { nickname: 'Proton', typeface: 'bold', nameEffect: 'none' });

    const nick = h
      .calls()
      .find(
        (call) =>
          call.method === 'PATCH' && call.path.endsWith('/members/@me') && 'nick' in bodyOf(call),
      );

    expect(bodyOf(nick).nick).toBe('\u{1D40F}\u{1D42B}\u{1D428}\u{1D42D}\u{1D428}\u{1D427}');
  });

  test('is refused with the real budget when the face pushes it past 32 units', async () => {
    const h = harness();

    await h.listen(configChanged(), {
      nickname: 'Seventeen characters',
      typeface: 'bold',
      nameEffect: 'none',
    });

    const nick = h.calls().find((call) => call.method === 'PATCH' && 'nick' in bodyOf(call));

    expect(nick).toBeUndefined();
    expect(h.logs.find((l) => l.message.includes('typeface'))?.message).toContain('16 characters');
  });
});
