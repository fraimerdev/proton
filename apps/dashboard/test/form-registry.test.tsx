import { describe, expect, test } from 'bun:test';
import type { FieldDescriptor } from '@proton/core';
import { protonFields, zodToDescriptors } from '@proton/core';
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
      'colour',
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

  test('an unknown kind renders a visible error, not nothing', () => {
    const rogue = {
      kind: 'hologram',
      path: 'x',
      label: 'Hologram',
      optional: false,
    } as unknown as FieldDescriptor;

    const html = render(
      <GeneratedForm descriptors={[rogue]} values={{}} onChange={() => undefined} />,
    );

    expect(resolveFieldComponent(rogue).name).toBe('UnsupportedFieldInput');
    expect(html).toContain('role="alert"');
    expect(html).toContain('unsupported field type');
    expect(html).toContain('hologram');
  });

  test('an array of an unsupported kind is still refused', () => {
    const rogue = {
      kind: 'hologram',
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

    expect(html).toContain('minLength="1"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('value="Pong!"');
  });

  // The options live in a popover that is closed until it is opened, so what the page ships is the
  // trigger. What the popover would list is channelOptions' job, and is tested with it.
  test('channel-id renders a closed picker naming the empty state', () => {
    const html = renderField(ping, 'restrictToChannel', null);

    expect(html).toContain('picker-trigger');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('No channel');
  });

  test('channel-id shows the chosen channel, with the glyph for its type', () => {
    const html = renderField(ping, 'restrictToChannel', '500000000000000001');

    expect(html).toContain('general');
    expect(html).toContain('data-icon="hash"');
  });

  test('number renders a spinner carrying the schema’s own bounds', () => {
    const html = renderField(moderation, 'defaultBanDeleteDays', 3);

    expect(html).toContain('type="number"');

    expect(html).toContain('min="0"');
    expect(html).toContain('max="7"');
    expect(html).toContain('value="3"');
  });

  test('number does not surface JavaScript’s integer range as a bound', () => {
    const [field] = zodToDescriptors(z.object({ count: z.number().int() }));
    const html = renderField([field as FieldDescriptor], 'count', 1);

    expect(html).not.toContain('9007199254740991');
  });

  test('colour renders a picker and a typable hex, both showing the stored value', () => {
    const descriptors = zodToDescriptors(
      z.object({
        accent: z
          .number()
          .int()
          .min(0)
          .max(0xffffff)
          .default(0x5865f2)
          .register(protonFields, { field: 'colour', label: 'Accent colour' }),
      }),
    );

    const html = renderField(descriptors, 'accent', 0x5865f2);

    expect(html).toContain('type="color"');
    expect(html.split('value="#5865f2"').length - 1).toBe(2);
    expect(html).not.toContain('type="number"');
  });

  test('a colour that is short of six digits still renders as six', () => {
    const descriptors = zodToDescriptors(
      z.object({
        accent: z.number().int().register(protonFields, { field: 'colour', label: 'Accent' }),
      }),
    );

    expect(renderField(descriptors, 'accent', 0x0000ff)).toContain('value="#0000ff"');
  });

  test('enum renders one option per declared value', () => {
    const descriptors = zodToDescriptors(
      z.object({ mode: z.enum(['quiet', 'normal', 'loud']).default('normal') }),
    );
    const html = renderField(descriptors, 'mode', 'loud');

    expect(html).toContain('>Quiet<');
    expect(html).toContain('>Normal<');
    expect(html).toContain('selected=""');

    expect(html).not.toContain('Not set');
  });

  test('an optional enum offers an explicit empty choice', () => {
    const descriptors = zodToDescriptors(z.object({ mode: z.enum(['a', 'b']).optional() }));

    expect(renderField(descriptors, 'mode', undefined)).toContain('Not set');
  });

  test('role-id shows the chosen role as a chip carrying its colour', () => {
    const html = renderField(overrides, 'overrides.ban', ['600000000000000001']);

    expect(html).toContain('Moderator');
    expect(html).toContain('pick-dot');
    expect(html).not.toContain('Member');
  });

  test('duration renders the stored value and accepts it silently', () => {
    const html = renderField(cases, 'escalationWindow', '30d');

    expect(html).toContain('value="30d"');
    expect(html).not.toContain('is not a duration');
  });

  test('duration names the problem when the text is not one', () => {
    const html = renderField(moderation, 'defaultTimeoutDuration', '1 hour');

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('is not a duration');
    expect(html).toContain('30m');
  });

  test('a flat array renders one chip per element plus a way to add more', () => {
    const html = renderField(logging, 'ignoredChannels', [
      '500000000000000001',
      '500000000000000002',
    ]);

    expect(html.split('class="token"').length - 1).toBe(2);
    expect(html).toContain('Remove general');
    expect(html).toContain('Add Ignored channels');
    expect(html).toContain('field-stacked');
  });

  test('an empty array says so rather than rendering nothing', () => {
    const html = renderField(logging, 'ignoredChannels', []);

    expect(html).toContain('None yet.');
  });

  test('a full array stops offering to add and names the limit', () => {
    const full = Array.from({ length: 50 }, () => '500000000000000001');
    const html = renderField(logging, 'ignoredChannels', full);

    expect(html).toContain('Limit of 50 reached');
    expect(html).toContain('disabled=""');
  });

  test('an array of role ids becomes chips, not text boxes', () => {
    const html = renderField(overrides, 'overrides.ban', [
      '600000000000000001',
      '600000000000000002',
    ]);

    expect(html).toContain('Moderator');
    expect(html).toContain('Member');
    expect(html).not.toContain('type="text"');
  });

  test('an id no longer in the guild keeps its chip, so it can still be taken off', () => {
    const html = renderField(overrides, 'overrides.ban', ['600000000000000009']);

    expect(html).toContain('600000000000000009');
    expect(html).toContain('data-unknown="true"');
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
