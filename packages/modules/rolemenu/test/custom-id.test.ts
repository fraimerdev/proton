import { describe, expect, test } from 'bun:test';
import { encodeCustomId, MAX_CUSTOM_ID_LENGTH, parseCustomId } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { MODULE_ID, SELECT_BINDING_KEY } from '../src/config.ts';
import { readMenuBinding } from '../src/interactions.ts';

function encode(menuId: string, bindingKey: string): string {
  const encoded = encodeCustomId(MODULE_ID, menuId, bindingKey);
  if (!encoded.ok) throw new Error(encoded.humanReason);
  return encoded.customId;
}

describe('the custom_id rolemenu writes', () => {
  test('is still the namespaced form the fixture recorded', () => {
    expect(encode('colours', 'red')).toBe('proton:rolemenu:colours:red');
  });

  test('round-trips through the module’s reader', () => {
    expect(readMenuBinding(encode('colours', 'red'))).toEqual({
      menuId: 'colours',
      bindingKey: 'red',
    });
  });

  test('round-trips a dropdown’s own id', () => {
    expect(readMenuBinding(encode('colours', SELECT_BINDING_KEY))).toEqual({
      menuId: 'colours',
      bindingKey: SELECT_BINDING_KEY,
    });
  });
});

describe('readMenuBinding refuses everything that is not ours', () => {
  test.each([
    ['another module’s id', 'proton:starboard:board:jump'],
    ['a bare id with no namespace', 'colours:red'],
    ['our namespace with no module', 'proton:colours:red'],
    ['a near miss on the module name', 'proton:rolemenus:colours:red'],
    ['an empty string', ''],
    ['the prefix and nothing else', 'proton:rolemenu:'],
    ['a menu with no binding', 'proton:rolemenu:colours'],
    ['a menu with an empty binding', 'proton:rolemenu:colours:'],
    ['an empty menu id', 'proton:rolemenu::red'],
    ['one segment too many', 'proton:rolemenu:colours:red:extra'],
  ])('rejects %s', (_label, raw) => {
    expect(readMenuBinding(raw)).toBeNull();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { custom_id: 'proton:rolemenu:colours:red' }],
  ])('rejects %s rather than assuming a string', (_label, raw) => {
    expect(readMenuBinding(raw)).toBeNull();
  });

  test('is case-sensitive — a lookalike namespace is not ours', () => {
    expect(readMenuBinding('Proton:Rolemenu:colours:red')).toBeNull();
  });
});

describe('core’s parser and the module’s reader agree about ownership', () => {
  test('a malformed id of ours is recognised as ours and still refused', () => {
    const malformed = 'proton:rolemenu:colours:red:extra';

    expect(parseCustomId(malformed)?.moduleId).toBe(MODULE_ID);
    expect(readMenuBinding(malformed)).toBeNull();
  });

  test('another module’s id is not ours at all', () => {
    expect(parseCustomId('proton:starboard:board:jump')?.moduleId).toBe('starboard');
  });
});

describe('the recorded component interaction', () => {
  test('reads as the menu and binding the fixture names', () => {
    const raw = dispatch('interactionCreateComponent');
    const customId = (raw.d.data as { custom_id: string }).custom_id;

    expect(readMenuBinding(customId)).toEqual({ menuId: 'colours', bindingKey: 'red' });
  });
});

describe('the 100-character ceiling', () => {
  test('a menu id and key at the schema’s limits do not fit, which is why config checks', () => {
    const encoded = encodeCustomId(MODULE_ID, 'm'.repeat(64), 'k'.repeat(64));

    expect(encoded.ok).toBe(false);
    expect(encoded.ok ? 0 : encoded.length).toBeGreaterThan(MAX_CUSTOM_ID_LENGTH);
  });

  test('an ordinary menu id and key leave plenty of room', () => {
    expect(encode('colours', 'red').length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
  });
});
