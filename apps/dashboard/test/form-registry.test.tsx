import { describe, expect, test } from 'bun:test';
import type { FieldDescriptor } from '@proton/core';
import { zodToDescriptors } from '@proton/core';
import { pingConfigSchema } from '@proton/module-ping';
import { renderToStaticMarkup } from 'react-dom/server';
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

describe('field registry', () => {
  test('covers exactly the three kinds Gate 0 ships', () => {
    expect(SUPPORTED_FIELD_KINDS.sort()).toEqual(['boolean', 'channel-id', 'string']);
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
});

describe('rendering each supported field type', () => {
  const descriptors = zodToDescriptors(pingConfigSchema);

  test('ping’s schema produces exactly the three Gate 0 field types', () => {
    expect(descriptors.map((d) => d.kind)).toEqual(['boolean', 'string', 'channel-id']);
  });

  test('boolean renders a switch reflecting its value', () => {
    const html = render(
      <GeneratedForm
        descriptors={descriptors.filter((d) => d.kind === 'boolean')}
        values={{ enabled: true }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('checked=""');
    expect(html).toContain('Enabled');
  });

  test('string renders a text input carrying the schema’s bounds', () => {
    const html = render(
      <GeneratedForm
        descriptors={descriptors.filter((d) => d.kind === 'string')}
        values={{ response: 'Pong!' }}
        onChange={() => undefined}
      />,
    );

    // The 1..200 bounds come from the Zod schema, not from hand-written markup.
    expect(html).toContain('minLength="1"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('value="Pong!"');
  });

  test('channel-id renders a picker filtered to the declared channel types', () => {
    const html = render(
      <GeneratedForm
        descriptors={descriptors.filter((d) => d.kind === 'channel-id')}
        values={{ restrictToChannel: null }}
        onChange={() => undefined}
        channels={CHANNELS}
      />,
    );

    // channelTypes: [0] — text channels only, so the voice channel is excluded.
    expect(html).toContain('general');
    expect(html).not.toContain('voice');
    // Nullable, so it offers an explicit empty choice.
    expect(html).toContain('No channel');
  });

  test('the whole ping form renders every field in schema order', () => {
    const html = render(
      <GeneratedForm
        descriptors={descriptors}
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
