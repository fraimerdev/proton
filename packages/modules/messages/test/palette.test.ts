import { describe, expect, test } from 'bun:test';
import type { ActionRow } from '@proton/core';
import {
  MAX_SAVED_COMPONENTS,
  messagesConfigSchema,
  savedComponentsSchema,
  withFreshKeys,
} from '../src/config.ts';

// A non-link button that carries no action is refused by the schema, so the fixture has to give
// every one a real reply action or the palette tests would only ever be testing that refusal.
function buttons(...keys: string[]): ActionRow {
  return {
    kind: 'buttons',
    buttons: keys.map((key) => ({
      key,
      label: key,
      style: 'primary' as const,
      action: { kind: 'reply' as const, content: `pressed ${key}`, ephemeral: true },
    })),
  };
}

function select(key: string): ActionRow {
  return {
    kind: 'select',
    select: {
      key,
      placeholder: 'Pick one',
      minValues: 1,
      maxValues: 1,
      options: [
        {
          key: 'first',
          label: 'A',
          action: { kind: 'reply' as const, content: 'picked A', ephemeral: true },
        },
      ],
    },
  };
}

function keysOf(row: ActionRow): string[] {
  return row.kind === 'select' ? [row.select.key] : row.buttons.map((button) => button.key);
}

describe('the saved component palette', () => {
  test('is empty on a config that has never had one', () => {
    expect(messagesConfigSchema.parse({}).components).toEqual([]);
  });

  test('keeps a named row whole', () => {
    const entry = { name: 'Ticket buttons', row: buttons('open', 'close') };

    expect(savedComponentsSchema.parse([entry])).toEqual([entry]);
  });

  test('refuses two entries sharing a name, whatever the case', () => {
    const clash = savedComponentsSchema.safeParse([
      { name: 'Ticket', row: buttons('open') },
      { name: 'ticket', row: buttons('close') },
    ]);

    expect(clash.success).toBe(false);
    expect(clash.success === false && clash.error.issues[0]?.message).toContain(
      'could not say which of them you were inserting',
    );
  });

  test('refuses more than the palette holds', () => {
    const many = Array.from({ length: MAX_SAVED_COMPONENTS + 1 }, (_, i) => ({
      name: `component-${i}`,
      row: buttons(`k${i}`),
    }));

    expect(savedComponentsSchema.safeParse(many).success).toBe(false);
  });

  test('an unnamed entry is refused rather than saved blank', () => {
    expect(savedComponentsSchema.safeParse([{ name: '  ', row: buttons('a') }]).success).toBe(
      false,
    );
  });
});

/**
 * Inserting is a copy with freshened keys. A key repeated inside one message is unroutable — a
 * press carries only its key — so the palette entry cannot simply be appended as it stands.
 */
describe('withFreshKeys', () => {
  test('leaves a row alone when nothing it carries is taken', () => {
    const row = buttons('accept', 'decline');

    expect(withFreshKeys(row, new Set())).toEqual(row);
  });

  test('renames a button key the message already uses', () => {
    expect(keysOf(withFreshKeys(buttons('accept'), new Set(['accept'])))).toEqual(['accept-2']);
  });

  // Only the key moves. The label is what a member reads, and a copy that renamed itself to
  // "accept-2" on the button face would be a different button.
  test('leaves the label and the action of the copied button alone', () => {
    const fresh = withFreshKeys(buttons('accept'), new Set(['accept']));

    expect(fresh.kind === 'buttons' && fresh.buttons[0]?.label).toBe('accept');
  });

  test('keeps counting past a name that is also taken', () => {
    const taken = new Set(['accept', 'accept-2', 'accept-3']);

    expect(keysOf(withFreshKeys(buttons('accept'), taken))).toEqual(['accept-4']);
  });

  test('freshens every button in the row, and against each other', () => {
    expect(keysOf(withFreshKeys(buttons('a', 'a'), new Set()))).toEqual(['a', 'a-2']);
  });

  test('freshens a dropdown key too', () => {
    expect(keysOf(withFreshKeys(select('menu'), new Set(['menu'])))).toEqual(['menu-2']);
  });

  // rowKeys() carries the dropdown's own key and not its options': an option is only unique inside
  // its own dropdown, so freshening those would rename something that was never in the shared space.
  test('leaves the options of a dropdown alone', () => {
    const fresh = withFreshKeys(select('menu'), new Set(['menu']));

    expect(fresh.kind === 'select' && fresh.select.options[0]?.key).toBe('first');
  });

  test('never mutates the palette entry it copied from', () => {
    const row = buttons('accept');
    withFreshKeys(row, new Set(['accept']));

    expect(keysOf(row)).toEqual(['accept']);
  });

  test('the copy still satisfies the row schema, so it can be saved', () => {
    const fresh = withFreshKeys(buttons('accept', 'decline'), new Set(['accept', 'decline']));

    expect(savedComponentsSchema.safeParse([{ name: 'copy', row: fresh }]).success).toBe(true);
  });
});
