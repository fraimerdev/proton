import { describe, expect, test } from 'bun:test';
import type { FieldDescriptor } from '@proton/core';
import { zodToDescriptors } from '@proton/core';
import { casesFormSchema } from '@proton/module-cases';
import { loggingConfigSchema } from '@proton/module-logging';
import { moderationConfigSchema } from '@proton/module-moderation';
import { commandOverridesFormSchema } from '@proton/module-permissions';
import { pingConfigSchema } from '@proton/module-ping';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { GeneratedForm } from '../src/components/form/generated-form.tsx';
import {
  FIELD_COMPONENTS,
  resolveFieldComponent,
  SUPPORTED_FIELD_KINDS,
} from '../src/components/form/registry.tsx';

/** Server rendering keeps these tests DOM-free while still exercising the real components. */
function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

const CHANNELS = [
  { id: '500000000000000001', name: 'general', type: 0 },
  { id: '500000000000000002', name: 'voice', type: 2 },
];

const ROLES = [
  { id: '600000000000000001', name: 'Moderator', position: 5 },
  { id: '600000000000000002', name: 'Member', position: 1 },
];

/** Render one descriptor with the value it would hold, and hand back the markup. */
function renderField(
  descriptors: readonly FieldDescriptor[],
  path: string,
  value: unknown,
): string {
  const descriptor = descriptors.find((d) => d.path === path);
  if (!descriptor) throw new Error(`no descriptor at '${path}'`);

  return render(
    <GeneratedForm
      descriptors={[descriptor]}
      values={{ [path]: value }}
      onChange={() => undefined}
      channels={CHANNELS}
      roles={ROLES}
    />,
  );
}

describe('field registry', () => {
  test('covers every kind the v1 generator can emit', () => {
    expect(SUPPORTED_FIELD_KINDS.sort()).toEqual([
      'boolean',
      'channel-id',
      'duration',
      'enum',
      'number',
      'role-id',
      'string',
    ]);
  });

  test('every supported kind resolves to a component', () => {
    for (const kind of SUPPORTED_FIELD_KINDS) {
      expect(FIELD_COMPONENTS[kind]).toBeDefined();
    }
  });

  /**
   * A blank or skipped field would let an admin save a config containing a field
   * they never saw. An explicit error is the safer failure.
   */
  test('an unknown kind renders a visible error, not nothing', () => {
    const rogue = {
      kind: 'colour',
      path: 'x',
      label: 'Colour',
      optional: false,
    } as unknown as FieldDescriptor;

    const html = render(
      <GeneratedForm descriptors={[rogue]} values={{}} onChange={() => undefined} />,
    );

    expect(resolveFieldComponent(rogue).name).toBe('UnsupportedFieldInput');
    expect(html).toContain('role="alert"');
    expect(html).toContain('unsupported field type');
    expect(html).toContain('colour');
  });

  /**
   * An array of a kind this build cannot render must still fail loudly rather
   * than falling back to a list of unsupported placeholders.
   */
  test('an array of an unsupported kind is still refused', () => {
    const rogue = {
      kind: 'colour',
      path: 'palette',
      label: 'Palette',
      optional: false,
      array: true,
    } as unknown as FieldDescriptor;

    expect(resolveFieldComponent(rogue).name).toBe('UnsupportedFieldInput');
  });
});

describe('rendering each supported field type', () => {
  const ping = zodToDescriptors(pingConfigSchema);
  const moderation = zodToDescriptors(moderationConfigSchema);
  const cases = zodToDescriptors(casesFormSchema);
  const logging = zodToDescriptors(loggingConfigSchema);
  const overrides = zodToDescriptors(z.object({ overrides: commandOverridesFormSchema(['ban']) }));

  test('boolean renders a switch reflecting its value', () => {
    const html = renderField(ping, 'enabled', true);

    expect(html).toContain('role="switch"');
    expect(html).toContain('checked=""');
    expect(html).toContain('Enabled');
  });

  test('string renders a text input carrying the schema’s bounds', () => {
    const html = renderField(ping, 'response', 'Pong!');

    // The 1..200 bounds come from the Zod schema, not from hand-written markup.
    expect(html).toContain('minLength="1"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('value="Pong!"');
  });

  test('channel-id renders a picker filtered to the declared channel types', () => {
    const html = renderField(ping, 'restrictToChannel', null);

    // channelTypes: [0] — text channels only, so the voice channel is excluded.
    expect(html).toContain('general');
    expect(html).not.toContain('voice');
    // Nullable, so it offers an explicit empty choice.
    expect(html).toContain('No channel');
  });

  test('number renders a spinner carrying the schema’s own bounds', () => {
    const html = renderField(moderation, 'defaultBanDeleteDays', 3);

    expect(html).toContain('type="number"');
    // Discord caps ban message deletion at 7 days; the form says so because the
    // schema does.
    expect(html).toContain('min="0"');
    expect(html).toContain('max="7"');
    expect(html).toContain('value="3"');
  });

  /**
   * `.int()` is encoded by Zod as the ±MAX_SAFE_INTEGER range. That is a
   * JavaScript limit, not a rule an admin set, and a spinner capped at
   * 9007199254740991 reads as a bug.
   */
  test('number does not surface JavaScript’s integer range as a bound', () => {
    const [field] = zodToDescriptors(z.object({ count: z.number().int() }));
    const html = renderField([field as FieldDescriptor], 'count', 1);

    expect(html).not.toContain('9007199254740991');
  });

  test('enum renders one option per declared value', () => {
    const descriptors = zodToDescriptors(
      z.object({ mode: z.enum(['quiet', 'normal', 'loud']).default('normal') }),
    );
    const html = renderField(descriptors, 'mode', 'loud');

    expect(html).toContain('>quiet<');
    expect(html).toContain('>normal<');
    expect(html).toContain('selected=""');
    // Required, so no "not set" escape hatch that the schema would then reject.
    expect(html).not.toContain('Not set');
  });

  test('an optional enum offers an explicit empty choice', () => {
    const descriptors = zodToDescriptors(z.object({ mode: z.enum(['a', 'b']).optional() }));

    expect(renderField(descriptors, 'mode', undefined)).toContain('Not set');
  });

  test('role-id renders a role picker, highest role first', () => {
    const html = renderField(overrides, 'overrides.ban', ['600000000000000001']);

    expect(html).toContain('@Moderator');
    expect(html).toContain('@Member');
    expect(html.indexOf('@Moderator')).toBeLessThan(html.indexOf('@Member'));
  });

  test('duration renders the stored value and accepts it silently', () => {
    const html = renderField(cases, 'escalationWindow', '30d');

    expect(html).toContain('value="30d"');
    expect(html).not.toContain('is not a duration');
  });

  /**
   * The message names what a duration looks like. `tryParseDuration` is the
   * runtime's own parser, so the field cannot accept something the module will
   * then refuse on save.
   */
  test('duration names the problem when the text is not one', () => {
    const html = renderField(moderation, 'defaultTimeoutDuration', '1 hour');

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('is not a duration');
    expect(html).toContain('30m');
  });

  test('a flat array renders one control per element plus a way to add more', () => {
    const html = renderField(logging, 'ignoredChannels', [
      '500000000000000001',
      '500000000000000002',
    ]);

    // Two channel pickers, not one text box that could replace the whole list.
    expect(html.split('field-channel-id').length - 1).toBe(2);
    expect(html).toContain('Remove');
    expect(html).toContain('Add Ignored channels');
  });

  test('an empty array says so rather than rendering nothing', () => {
    const html = renderField(logging, 'ignoredChannels', []);

    expect(html).toContain('None yet.');
  });

  /**
   * The array's own `.max(50)` has to be visible where it applies. Letting an
   * admin build a 51st entry that the schema then rejects on save is the
   * "rejected for no visible reason" failure this exists to prevent.
   */
  test('a full array stops offering to add and names the limit', () => {
    const full = Array.from({ length: 50 }, () => '500000000000000001');
    const html = renderField(logging, 'ignoredChannels', full);

    expect(html).toContain('Limit of 50 reached');
    expect(html).toContain('disabled=""');
  });

  test('an array of role ids repeats the role picker, not a text box', () => {
    const html = renderField(overrides, 'overrides.ban', [
      '600000000000000001',
      '600000000000000002',
    ]);

    expect(html.split('field-role-id').length - 1).toBe(2);
    expect(html).not.toContain('type="text"');
  });

  test('the whole ping form renders every field in schema order', () => {
    const html = render(
      <GeneratedForm
        descriptors={ping}
        values={{ enabled: true, response: 'Pong!', restrictToChannel: null }}
        onChange={() => undefined}
        channels={CHANNELS}
      />,
    );

    expect(html.indexOf('data-path="enabled"')).toBeLessThan(html.indexOf('data-path="response"'));
    expect(html.indexOf('data-path="response"')).toBeLessThan(
      html.indexOf('data-path="restrictToChannel"'),
    );
  });
});

/**
 * The point of the generator: five shipped modules, no per-module form code.
 * If a module's schema grows a field the renderer cannot draw, this fails here
 * rather than in a guild admin's browser.
 */
describe('every shipped module renders from its own schema', () => {
  const schemas = [
    ['ping', pingConfigSchema],
    ['cases', casesFormSchema],
    ['moderation', moderationConfigSchema],
    ['logging', loggingConfigSchema],
  ] as const;

  for (const [id, schema] of schemas) {
    test(`${id} produces only renderable descriptors`, () => {
      const descriptors = zodToDescriptors(schema);

      expect(descriptors.length).toBeGreaterThan(0);
      for (const descriptor of descriptors) {
        expect(resolveFieldComponent(descriptor).name).not.toBe('UnsupportedFieldInput');
      }
    });
  }

  test('permissions renders once its override fields are built from the loaded commands', () => {
    const descriptors = zodToDescriptors(
      z.object({ overrides: commandOverridesFormSchema(['ban', 'kick']) }),
    );

    expect(descriptors.map((d) => d.path)).toEqual(['overrides.ban', 'overrides.kick']);
    for (const descriptor of descriptors) {
      expect(descriptor.kind).toBe('role-id');
      expect(descriptor.array).toBe(true);
      expect(resolveFieldComponent(descriptor).name).not.toBe('UnsupportedFieldInput');
    }
  });
});
