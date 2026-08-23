import { describe, expect, test } from 'bun:test';
import { MAX_BUTTONS_PER_ROW, MAX_CUSTOM_ID_LENGTH, parseCustomId } from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { MODULE_ID, type RolemenuMenu, SELECT_BINDING_KEY } from '../src/config.ts';
import { buildComponents, type MessageComponent } from '../src/message.ts';

const CHANNEL = '500000000000000001';
const ROLE = '700000000000000001';

function menu(overrides: Partial<RolemenuMenu> = {}): RolemenuMenu {
  return {
    id: 'colours',
    channelId: CHANNEL,
    kind: 'button',
    mode: 'toggle',
    bindings: [{ key: 'red', roleId: ROLE }],
    ...overrides,
  };
}

function bindings(count: number): RolemenuMenu['bindings'] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `k${index}`,
    roleId: ROLE,
  }));
}

function built(subject: RolemenuMenu): MessageComponent[] {
  const result = buildComponents(subject);
  if (!result.ok) throw new Error(result.humanReason);
  return result.components;
}

function rowOf(component: MessageComponent): MessageComponent[] {
  return component.components as MessageComponent[];
}

describe('buildComponents', () => {
  test('a button menu writes one custom_id per binding, each routable back to the menu', () => {
    const rows = built(menu({ bindings: bindings(2) }));

    expect(rows).toHaveLength(1);
    expect(rowOf(rows[0] as MessageComponent).map((button) => button.custom_id)).toEqual([
      'proton:rolemenu:colours:k0',
      'proton:rolemenu:colours:k1',
    ]);
  });

  test('buttons are split into rows of five, which is all Discord allows', () => {
    const rows = built(menu({ bindings: bindings(MAX_BUTTONS_PER_ROW + 1) }));

    expect(rows).toHaveLength(2);
    expect(rowOf(rows[0] as MessageComponent)).toHaveLength(MAX_BUTTONS_PER_ROW);
    expect(rowOf(rows[1] as MessageComponent)).toHaveLength(1);
  });

  test('a dropdown carries the reserved binding key, not a role’s key', () => {
    const rows = built(menu({ kind: 'select', bindings: bindings(3) }));
    const select = rowOf(rows[0] as MessageComponent)[0] as MessageComponent;

    expect(select.type).toBe(ComponentType.StringSelect);
    expect(parseCustomId(select.custom_id)).toEqual({
      moduleId: MODULE_ID,
      action: 'colours',
      args: [SELECT_BINDING_KEY],
    });
  });

  test('a reaction menu has no components — the message carries reactions instead', () => {
    expect(built(menu({ kind: 'reaction', messageId: CHANNEL }))).toEqual([]);
  });
});

describe('a menu whose ids will not fit a custom_id', () => {
  const unaddressable = menu({
    id: 'm'.repeat(64),
    bindings: [{ key: 'k'.repeat(64), roleId: ROLE }],
  });

  test('is refused rather than posted with a button nothing can route', () => {
    expect(buildComponents(unaddressable).ok).toBe(false);
  });

  test('names the cap and what to shorten, so an admin can fix it', () => {
    const result = buildComponents(unaddressable);

    if (result.ok) throw new Error('expected the menu to be refused');

    expect(result.humanReason).toContain(String(MAX_CUSTOM_ID_LENGTH));
    expect(result.humanReason).toContain(MODULE_ID);
  });

  test('a dropdown refuses too — the guard is not a button-only branch', () => {
    const wide = menu({ id: 'm'.repeat(MAX_CUSTOM_ID_LENGTH), kind: 'select' });

    expect(buildComponents(wide).ok).toBe(false);
  });
});
