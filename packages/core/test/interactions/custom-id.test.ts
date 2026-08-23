import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { MAX_CUSTOM_ID_LENGTH } from '../../src/actions/payloads.ts';
import { encodeCustomId, parseCustomId } from '../../src/interactions/custom-id.ts';

function mustEncode(moduleId: string, action: string, ...args: string[]): string {
  const result = encodeCustomId(moduleId, action, ...args);
  if (!result.ok) throw new Error(result.humanReason);
  return result.customId;
}

const segment = fc.string({
  unit: fc.constantFrom('a', 'Z', '0', '-', '_', ':', '\\', '*', 'é', '😀'),
  maxLength: 8,
});

const nonEmptySegment = fc.string({
  unit: fc.constantFrom('a', 'Z', '0', '-', '_', ':', '\\', '*', 'é', '😀'),
  minLength: 1,
  maxLength: 8,
});

describe('encodeCustomId', () => {
  test('writes the namespace, the module, the action and then the args', () => {
    expect(encodeCustomId('rolemenu', 'colours', 'red')).toEqual({
      ok: true,
      customId: 'proton:rolemenu:colours:red',
    });
  });

  test('an action with no args is a complete id', () => {
    expect(mustEncode('ticket', 'close')).toBe('proton:ticket:close');
  });

  test('takes as many args as fit', () => {
    expect(mustEncode('giveaway', 'enter', '17', 'b', 'c')).toBe('proton:giveaway:enter:17:b:c');
  });

  test('refuses rather than throwing, so a caller answers the member instead of crashing', () => {
    expect(() => encodeCustomId('rolemenu', 'm'.repeat(64), 'k'.repeat(64))).not.toThrow();
  });
});

describe('parseCustomId', () => {
  test('splits an id into the module, the action and the args', () => {
    expect(parseCustomId('proton:rolemenu:colours:red')).toEqual({
      moduleId: 'rolemenu',
      action: 'colours',
      args: ['red'],
    });
  });

  test('an id with no args parses to an empty arg list', () => {
    expect(parseCustomId('proton:ticket:close')).toEqual({
      moduleId: 'ticket',
      action: 'close',
      args: [],
    });
  });

  test.each([
    ['a non-string', 42],
    ['undefined', undefined],
    ['an object', { custom_id: 'proton:ticket:close' }],
    ['an empty string', ''],
    ['another namespace', 'other:ticket:close'],
    ['no namespace at all', 'ticket:close'],
    ['a namespace and a module but no action', 'proton:ticket'],
    ['an empty module id', 'proton::close'],
    ['an empty action', 'proton:ticket:'],
    ['a dangling escape', 'proton:ticket:close\\'],
    ['an escape of something that is not special', 'proton:ticket:clo\\se'],
  ])('refuses %s', (_label, raw) => {
    expect(parseCustomId(raw)).toBeNull();
  });

  test('refuses an id longer than Discord allows, rather than routing a truncation', () => {
    const overlong = `proton:ticket:close:${'x'.repeat(MAX_CUSTOM_ID_LENGTH)}`;

    expect(overlong.length).toBeGreaterThan(MAX_CUSTOM_ID_LENGTH);
    expect(parseCustomId(overlong)).toBeNull();
  });
});

describe('args that contain the separator', () => {
  test('are escaped rather than splitting the id into more args', () => {
    const id = mustEncode('tag', 'show', 'a:b');

    expect(id).toBe('proton:tag:show:a\\:b');
    expect(parseCustomId(id)).toEqual({ moduleId: 'tag', action: 'show', args: ['a:b'] });
  });

  test('an arg that is itself an escape sequence still round-trips', () => {
    expect(parseCustomId(mustEncode('tag', 'show', '\\:'))).toEqual({
      moduleId: 'tag',
      action: 'show',
      args: ['\\:'],
    });
  });

  test('a module id or action carrying one round-trips too', () => {
    expect(parseCustomId(mustEncode('a:b', 'c\\d', 'e'))).toEqual({
      moduleId: 'a:b',
      action: 'c\\d',
      args: ['e'],
    });
  });

  test('an empty arg is preserved, not dropped', () => {
    expect(parseCustomId(mustEncode('tag', 'show', ''))).toEqual({
      moduleId: 'tag',
      action: 'show',
      args: [''],
    });
  });
});

describe('the 100-character ceiling', () => {
  test('an encode is refused instead of truncated, and the refusal names the cap', () => {
    const result = encodeCustomId('rolemenu', 'm'.repeat(64), 'k'.repeat(64));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the encode to be refused');

    expect(result.length).toBeGreaterThan(MAX_CUSTOM_ID_LENGTH);
    expect(result.humanReason).toContain(String(MAX_CUSTOM_ID_LENGTH));
    expect(result.humanReason).toContain('rolemenu');
  });

  test('an id exactly at the ceiling is allowed', () => {
    const action = 'a'.repeat(MAX_CUSTOM_ID_LENGTH - 'proton:tag:'.length);
    const result = encodeCustomId('tag', action);

    expect(result.ok).toBe(true);
    expect(result.ok && result.customId.length).toBe(MAX_CUSTOM_ID_LENGTH);
  });
});

describe('module ownership', () => {
  test('a near miss on a module name is a different module', () => {
    expect(parseCustomId('proton:rolemenus:colours:red')?.moduleId).toBe('rolemenus');
    expect(parseCustomId('proton:rolemenu:colours:red')?.moduleId).toBe('rolemenu');
  });
});

describe('ids that are not ours', () => {
  test.each([
    ['a component from another bot entirely', 'literally:anything'],
    ['one that is only a word', 'anything'],
    ['a well-formed id under a near-miss namespace', 'protons:rolemenu:colours:red'],
    ['a namespace that differs only in case', 'Proton:rolemenu:colours:red'],
    ['a namespace with padding around it', ' proton:rolemenu:colours'],
    ['a namespace that is a prefix of ours', 'proto:rolemenu:colours'],
    ['an escaped namespace, which is not a spelling of ours', '\\proton:rolemenu:colours'],
    ['a leading empty namespace', ':proton:rolemenu:colours'],
  ])('is not routed to a module: %s', (_label, raw) => {
    expect(parseCustomId(raw)).toBeNull();
  });

  test('an id one character over the ceiling is refused, the one at it is not', () => {
    const filler = (length: number) => `proton:tag:${'a'.repeat(length - 'proton:tag:'.length)}`;

    expect(parseCustomId(filler(MAX_CUSTOM_ID_LENGTH))).not.toBeNull();
    expect(parseCustomId(filler(MAX_CUSTOM_ID_LENGTH + 1))).toBeNull();
  });
});

describe('codec properties', () => {
  test('encoding then parsing returns exactly what went in', () => {
    fc.assert(
      fc.property(
        nonEmptySegment,
        nonEmptySegment,
        fc.array(segment, { maxLength: 4 }),
        (moduleId, action, args) => {
          const encoded = encodeCustomId(moduleId, action, ...args);
          if (!encoded.ok) return;

          expect(parseCustomId(encoded.customId)).toEqual({ moduleId, action, args });
        },
      ),
    );
  });

  test('every id that parses re-encodes to itself, so routing has one spelling', () => {
    const candidate = fc.string({
      unit: fc.constantFrom('proton', 'rolemenu', 'colours', ':', '\\', 'a'),
      maxLength: 8,
    });

    fc.assert(
      fc.property(candidate, (raw) => {
        const parsed = parseCustomId(raw);
        if (!parsed) return;

        expect(mustEncode(parsed.moduleId, parsed.action, ...parsed.args)).toBe(raw);
      }),
    );
  });

  test('an encoded id never carries more args than were handed to it', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 6 }), (args) => {
        const encoded = encodeCustomId('m', 'a', ...args);
        if (!encoded.ok) return;

        expect(parseCustomId(encoded.customId)?.args.length).toBe(args.length);
      }),
    );
  });
});

const anyText = fc.string({ unit: 'grapheme', maxLength: 12 });
const anyNonEmptyText = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 });

describe('codec properties over arbitrary text', () => {
  test('any module, action and args a module can hold round-trip unchanged', () => {
    fc.assert(
      fc.property(
        anyNonEmptyText,
        anyNonEmptyText,
        fc.array(anyText, { maxLength: 4 }),
        (moduleId, action, args) => {
          const encoded = encodeCustomId(moduleId, action, ...args);
          if (!encoded.ok) return;

          expect(parseCustomId(encoded.customId)).toEqual({ moduleId, action, args });
        },
      ),
    );
  });

  test('an encode is refused only for length, and the reported length is the id it built', () => {
    fc.assert(
      fc.property(
        anyNonEmptyText,
        anyNonEmptyText,
        fc.array(anyText, { maxLength: 8 }),
        (moduleId, action, args) => {
          const encoded = encodeCustomId(moduleId, action, ...args);

          if (encoded.ok) {
            expect(encoded.customId.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
            return;
          }

          expect(encoded.length).toBeGreaterThan(MAX_CUSTOM_ID_LENGTH);
          expect(encoded.humanReason).toContain(String(encoded.length));
        },
      ),
    );
  });

  test('parsing anything Discord could send answers rather than throwing', () => {
    fc.assert(
      fc.property(
        fc.oneof(anyText, fc.integer(), fc.constant(null), fc.constant(undefined), fc.object()),
        (raw) => {
          expect(() => parseCustomId(raw)).not.toThrow();
        },
      ),
    );
  });

  test('nothing that fails to start with the literal namespace is claimed by a module', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('proton', 'p', ':', '\\', 'a'), maxLength: 6 }),
        (raw) => {
          if (raw.startsWith('proton:')) return;

          expect(parseCustomId(raw)).toBeNull();
        },
      ),
    );
  });
});
