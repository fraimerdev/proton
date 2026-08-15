import { describe, expect, test } from 'bun:test';
import { MAX_CUSTOM_ID_LENGTH, UnsupportedSchemaError, zodToDescriptors } from '@proton/core';
import {
  MAX_BINDINGS_PER_MENU,
  MAX_MENUS,
  type RolemenuMenu,
  rolemenuConfigSchema,
  rolemenuDefaultConfig,
  rolemenuFormSchema,
  rolemenuMenusSchema,
} from '../src/config.ts';
import { SELECT_BINDING_KEY } from '../src/custom-id.ts';

const CHANNEL = '500000000000000001';
const MESSAGE = '1400000000000000001';
const RED = '410000000000000001';
const BLUE = '410000000000000002';

function menu(overrides: Partial<RolemenuMenu> = {}): RolemenuMenu {
  return {
    id: 'colours',
    channelId: CHANNEL,
    kind: 'button',
    mode: 'toggle',
    bindings: [{ key: 'red', roleId: RED }],
    ...overrides,
  };
}

/** The messages, not just the failure — an admin has to be able to act on them. */
function messages(menus: unknown[]): string[] {
  const parsed = rolemenuMenusSchema.safeParse(menus);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function paths(menus: unknown[]): string[] {
  const parsed = rolemenuMenusSchema.safeParse(menus);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
}

describe('defaults', () => {
  test('satisfy the schema', () => {
    expect(rolemenuConfigSchema.safeParse(rolemenuDefaultConfig).success).toBe(true);
  });

  test('give nobody a role', () => {
    // An enabled menu with no menus configured would do nothing; an enabled menu
    // with a guessed role would hand out a role the admin never chose.
    expect(rolemenuDefaultConfig.enabled).toBe(false);
    expect(rolemenuDefaultConfig.menus).toEqual([]);
  });
});

describe('the §9 boundary', () => {
  test('the config schema is outside the v1 form generator, by design', () => {
    // Not a bug to fix by widening the generator — §9 rules that out in as many
    // words, and `cases` refuses for the same reason with the same shape.
    expect(() => zodToDescriptors(rolemenuConfigSchema)).toThrow(UnsupportedSchemaError);
  });

  test('the form schema is the same object minus the part that needs a bespoke editor', () => {
    expect(Object.keys(rolemenuFormSchema.shape)).toEqual(['enabled']);
    expect(zodToDescriptors(rolemenuFormSchema).map((field) => field.path)).toEqual(['enabled']);
  });

  test('every form key is a real config key, which is what the registry enforces', () => {
    const configKeys = new Set(Object.keys(rolemenuConfigSchema.shape));

    for (const key of Object.keys(rolemenuFormSchema.shape)) {
      expect(configKeys.has(key)).toBe(true);
    }
  });
});

describe('menu ids', () => {
  test('a duplicate is refused, because a custom_id could not say which is meant', () => {
    expect(messages([menu(), menu()])[0]).toContain("duplicate menu id 'colours'");
    expect(paths([menu(), menu()])).toEqual(['1.id']);
  });

  test('two different menus are fine', () => {
    expect(rolemenuMenusSchema.safeParse([menu(), menu({ id: 'pronouns' })]).success).toBe(true);
  });

  test('a colon is refused — it is the custom_id separator', () => {
    expect(rolemenuMenusSchema.safeParse([menu({ id: 'col:ours' })]).success).toBe(false);
  });

  test('spaces and other punctuation are refused', () => {
    for (const id of ['my menu', 'menu!', '-leading', '']) {
      expect(rolemenuMenusSchema.safeParse([menu({ id })]).success).toBe(false);
    }
  });
});

describe('binding keys', () => {
  test('a duplicate within one menu is refused', () => {
    // Two bindings on one key make resolution ambiguous, and the second is dead
    // config that looks live.
    const clashing = [
      menu({
        bindings: [
          { key: 'red', roleId: RED },
          { key: 'red', roleId: BLUE },
        ],
      }),
    ];

    expect(messages(clashing)[0]).toContain("duplicate binding key 'red'");
    expect(paths(clashing)).toEqual(['0.bindings.1.key']);
  });

  test('the same key in two different menus is fine', () => {
    expect(rolemenuMenusSchema.safeParse([menu(), menu({ id: 'pronouns' })]).success).toBe(true);
  });

  test('two keys may share a role', () => {
    expect(
      rolemenuMenusSchema.safeParse([
        menu({
          bindings: [
            { key: 'red', roleId: RED },
            { key: 'crimson', roleId: RED },
          ],
        }),
      ]).success,
    ).toBe(true);
  });

  test('a colon is refused', () => {
    expect(
      rolemenuMenusSchema.safeParse([menu({ bindings: [{ key: 'a:b', roleId: RED }] })]).success,
    ).toBe(false);
  });

  test('the dropdown’s reserved key is refused', () => {
    const reserved = [menu({ bindings: [{ key: SELECT_BINDING_KEY, roleId: RED }] })];

    expect(rolemenuMenusSchema.safeParse(reserved).success).toBe(false);
    expect(messages(reserved)[0]).toContain('reserved');
  });

  test('an emoji is a perfectly good key — that is what a reaction menu binds', () => {
    expect(
      rolemenuMenusSchema.safeParse([
        menu({ kind: 'reaction', messageId: MESSAGE, bindings: [{ key: '⭐', roleId: RED }] }),
      ]).success,
    ).toBe(true);
  });

  test('a custom emoji id is a good key too', () => {
    expect(
      rolemenuMenusSchema.safeParse([
        menu({
          kind: 'reaction',
          messageId: MESSAGE,
          bindings: [{ key: '1300000000000000001', roleId: RED }],
        }),
      ]).success,
    ).toBe(true);
  });
});

describe('the 100-character custom_id ceiling', () => {
  test('a menu that could not address its own buttons is refused on save', () => {
    // Discord rejects the whole message rather than truncating, so discovering
    // this when someone runs /rolemenu is discovering it far too late.
    const unaddressable = [
      menu({ id: 'm'.repeat(64), bindings: [{ key: 'k'.repeat(64), roleId: RED }] }),
    ];

    expect(messages(unaddressable)[0]).toContain(String(MAX_CUSTOM_ID_LENGTH));
    expect(messages(unaddressable)[0]).toContain('Shorten the menu id or the key');
    expect(paths(unaddressable)).toEqual(['0.bindings.0.key']);
  });

  test('is checked for reaction menus too, since kind is one dropdown away', () => {
    const unaddressable = [
      menu({
        id: 'm'.repeat(64),
        kind: 'reaction',
        messageId: MESSAGE,
        bindings: [{ key: 'k'.repeat(64), roleId: RED }],
      }),
    ];

    expect(rolemenuMenusSchema.safeParse(unaddressable).success).toBe(false);
  });

  test('an ordinary menu passes', () => {
    expect(rolemenuMenusSchema.safeParse([menu()]).success).toBe(true);
  });
});

describe('reaction menus', () => {
  test('need the id of the message they react to', () => {
    // A reaction dispatch carries a channel, a message and an emoji. Without the
    // message id the menu can never be recognised at all.
    const unmatched = [menu({ kind: 'reaction' })];

    expect(messages(unmatched)[0]).toContain('a reaction menu needs the id of the message');
    expect(paths(unmatched)).toEqual(['0.messageId']);
  });

  test('are fine once it is set', () => {
    expect(
      rolemenuMenusSchema.safeParse([menu({ kind: 'reaction', messageId: MESSAGE })]).success,
    ).toBe(true);
  });

  test('button and dropdown menus do not need one — the custom_id names the menu', () => {
    expect(rolemenuMenusSchema.safeParse([menu({ kind: 'button' })]).success).toBe(true);
    expect(rolemenuMenusSchema.safeParse([menu({ kind: 'select' })]).success).toBe(true);
  });
});

describe('arity', () => {
  test('a menu with no bindings is refused — it would be a message that does nothing', () => {
    expect(rolemenuMenusSchema.safeParse([menu({ bindings: [] })]).success).toBe(false);
  });

  test('the binding cap is the tightest of Discord’s three limits', () => {
    const bindings = Array.from({ length: MAX_BINDINGS_PER_MENU + 1 }, (_, index) => ({
      key: `k${index}`,
      roleId: RED,
    }));

    expect(rolemenuMenusSchema.safeParse([menu({ bindings })]).success).toBe(false);
    expect(
      rolemenuMenusSchema.safeParse([menu({ bindings: bindings.slice(0, MAX_BINDINGS_PER_MENU) })])
        .success,
    ).toBe(true);
  });

  test('menus per guild are capped', () => {
    const menus = Array.from({ length: MAX_MENUS + 1 }, (_, index) => menu({ id: `m${index}` }));

    expect(rolemenuMenusSchema.safeParse(menus).success).toBe(false);
  });
});
