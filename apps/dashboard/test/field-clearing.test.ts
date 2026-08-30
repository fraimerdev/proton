import { describe, expect, test } from 'bun:test';
import type { ChannelIdField, RoleIdField, StringField } from '@proton/core';
import { brandingConfigSchema } from '@proton/module-branding/config';
import { honeypotConfigSchema } from '@proton/module-honeypot/config';
import { verificationConfigSchema } from '@proton/module-verification/config';
import { clearingOf, emptied } from '../src/components/form/fields.tsx';

function text(over: Partial<StringField> = {}): StringField {
  return {
    kind: 'string',
    path: 'nickname',
    label: 'Nickname',
    optional: true,
    ...over,
  } as StringField;
}

function role(over: Partial<RoleIdField> = {}): RoleIdField {
  return { kind: 'role-id', path: 'roleId', label: 'Role', optional: true, ...over } as RoleIdField;
}

function channel(over: Partial<ChannelIdField> = {}): ChannelIdField {
  return {
    kind: 'channel-id',
    path: 'channelId',
    label: 'Channel',
    optional: true,
    ...over,
  } as ChannelIdField;
}

describe('clearing an id picker', () => {
  test('a cleared optional field is written as undefined, never the picker’s null', () => {
    expect(clearingOf(role()).cleared(null)).toBeUndefined();
    expect(clearingOf(channel()).cleared(null)).toBeUndefined();
  });

  test('a chosen id is passed through untouched', () => {
    expect(clearingOf(role()).cleared('1450210082339028995')).toBe('1450210082339028995');
  });

  test('a field carrying a default clears back to that default, not to nothing', () => {
    const inherit = channel({ optional: false, defaultValue: '' });

    expect(clearingOf(inherit).cleared(null)).toBe('');
    expect(clearingOf(inherit).clearable).toBe(true);
  });

  test('a required field with no default offers no way to clear itself', () => {
    expect(clearingOf(role({ optional: false })).clearable).toBe(false);
  });
});

describe('emptying a text box', () => {
  test('an emptied optional box is unset, not the empty string its schema rejects', () => {
    expect(emptied(text(), '')).toBeUndefined();
  });

  test('typed text is passed through untouched', () => {
    expect(emptied(text(), 'Proton')).toBe('Proton');
  });

  test('a required box keeps the empty string, so the schema still calls it missing', () => {
    expect(emptied(text({ optional: false }), '')).toBe('');
  });

  /**
   * A default must NOT be substituted here. Ping's "Reply text" is `.default('Pong!')` and not
   * optional; refilling the box on '' made backspace loop Pong! -> Pong -> … -> P -> Pong!, and
   * because the rewritten value equalled the stored one the save bar never appeared either.
   */
  test('a box carrying a default can still be emptied, so backspace does not refill it', () => {
    expect(emptied(text({ optional: false, defaultValue: 'Pong!' }), '')).toBe('');
    expect(emptied(text({ optional: false, defaultValue: 'Pong!' }), 'Pong')).toBe('Pong');
  });

  /** Branding's own help text says to leave the nickname empty — and '' is exactly what it refuses. */
  test('branding accepts an emptied nickname and rejects the empty string', () => {
    const base = brandingConfigSchema.parse({}) as Record<string, unknown>;

    expect(brandingConfigSchema.safeParse({ ...base, nickname: emptied(text(), '') }).success).toBe(
      true,
    );
    expect(brandingConfigSchema.safeParse({ ...base, nickname: '' }).success).toBe(false);
  });
});

/**
 * The bug this pins: RoleIdFieldInput used to hand SinglePicker's own `null` straight to the form,
 * and ModuleConfigService.update safeParses the WHOLE config — so unsetting one role rejected every
 * other edit on the page with "expected string, received null" and the module could not be saved.
 */
describe('what a cleared picker writes is what the module schemas accept', () => {
  const cases = [
    { name: 'honeypot exemptAdminRoleId', schema: honeypotConfigSchema, key: 'exemptAdminRoleId' },
    {
      name: 'verification quarantineRoleId',
      schema: verificationConfigSchema,
      key: 'quarantineRoleId',
    },
    {
      name: 'verification verifiedRoleId',
      schema: verificationConfigSchema,
      key: 'verifiedRoleId',
    },
  ] as const;

  for (const { name, schema, key } of cases) {
    test(`${name} accepts a cleared value and rejects a null one`, () => {
      const base = schema.parse({}) as Record<string, unknown>;

      expect(schema.safeParse({ ...base, [key]: clearingOf(role()).cleared(null) }).success).toBe(
        true,
      );

      // The other half of the pin: null really is rejected, so the test above is not vacuous.
      expect(schema.safeParse({ ...base, [key]: null }).success).toBe(false);
    });
  }
});
