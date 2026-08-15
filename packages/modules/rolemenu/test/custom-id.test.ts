import { describe, expect, test } from 'bun:test';
import { MAX_CUSTOM_ID_LENGTH } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import {
  CUSTOM_ID_PREFIX,
  encodeCustomId,
  hasRolemenuPrefix,
  parseCustomId,
  SELECT_BINDING_KEY,
} from '../src/custom-id.ts';

describe('encodeCustomId', () => {
  test('writes the namespaced form the fixture recorded', () => {
    // The recorded button press carries exactly this id, so a change to the
    // grammar breaks a test rather than every menu already posted in a guild.
    expect(encodeCustomId('colours', 'red')).toBe('proton:rolemenu:colours:red');
  });

  test('round-trips through the parser', () => {
    expect(parseCustomId(encodeCustomId('colours', 'red'))).toEqual({
      menuId: 'colours',
      bindingKey: 'red',
    });
  });

  test('round-trips a dropdown’s own id', () => {
    expect(parseCustomId(encodeCustomId('colours', SELECT_BINDING_KEY))).toEqual({
      menuId: 'colours',
      bindingKey: SELECT_BINDING_KEY,
    });
  });
});

describe('parseCustomId refuses everything that is not ours', () => {
  test.each([
    ['another module’s id', 'proton:starboard:board:jump'],
    ['a bare id with no namespace', 'colours:red'],
    ['our namespace with no module', 'proton:colours:red'],
    ['a near miss on the module name', 'proton:rolemenus:colours:red'],
    ['an empty string', ''],
    ['the prefix and nothing else', CUSTOM_ID_PREFIX],
    ['a menu with no binding', 'proton:rolemenu:colours'],
    ['a menu with an empty binding', 'proton:rolemenu:colours:'],
    ['an empty menu id', 'proton:rolemenu::red'],
    ['one segment too many', 'proton:rolemenu:colours:red:extra'],
  ])('rejects %s', (_label, raw) => {
    expect(parseCustomId(raw)).toBeNull();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { custom_id: 'proton:rolemenu:colours:red' }],
  ])('rejects %s rather than assuming a string', (_label, raw) => {
    expect(parseCustomId(raw)).toBeNull();
    expect(hasRolemenuPrefix(raw)).toBe(false);
  });

  test('is case-sensitive — a lookalike namespace is not ours', () => {
    expect(parseCustomId('Proton:Rolemenu:colours:red')).toBeNull();
  });
});

describe('the prefix test and the parser agree about ownership', () => {
  test('a malformed id of ours is recognised as ours and still refused', () => {
    // The distinction the handler needs: "not mine, leave it alone" versus
    // "mine and unreadable". Only the first may be answered by another module.
    const malformed = 'proton:rolemenu:colours:red:extra';

    expect(hasRolemenuPrefix(malformed)).toBe(true);
    expect(parseCustomId(malformed)).toBeNull();
  });

  test('another module’s id is not ours at all', () => {
    expect(hasRolemenuPrefix('proton:starboard:board:jump')).toBe(false);
  });
});

describe('the recorded component interaction', () => {
  test('parses to the menu and binding the fixture names', () => {
    const raw = dispatch('interactionCreateComponent');
    const customId = (raw.d.data as { custom_id: string }).custom_id;

    expect(parseCustomId(customId)).toEqual({ menuId: 'colours', bindingKey: 'red' });
  });
});

describe('the 100-character ceiling', () => {
  test('a menu id and key at the schema’s limits do not fit, which is why config checks', () => {
    // 64 + 64 plus the prefix is well over 100. The bounds on the two fields are
    // deliberately not tight enough to guarantee a fit on their own — the
    // encoded length is what config refuses, because that is the real rule.
    expect(encodeCustomId('m'.repeat(64), 'k'.repeat(64)).length).toBeGreaterThan(
      MAX_CUSTOM_ID_LENGTH,
    );
  });

  test('an ordinary menu id and key leave plenty of room', () => {
    expect(encodeCustomId('colours', 'red').length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
  });
});
