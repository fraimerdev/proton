import { describe, expect, test } from 'bun:test';
import type { FieldKind } from '@proton/core';
import { fieldDescriptorSchema } from '@proton/core';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleForm } from '../src/components/module/form.ts';
import {
  ChannelField,
  Choice,
  Colour,
  Duration,
  ModuleFormProvider,
  Num,
  RoleField,
  Text,
  Toggle,
  Tokens,
} from '../src/components/module/inputs.tsx';

const CHANNELS = [
  { id: '500000000000000001', name: 'general', type: 0 },
  { id: '500000000000000002', name: 'voice', type: 2 },
];

const ROLES = [
  { id: '600000000000000001', name: 'Moderator', position: 5, color: 0x5865f2 },
  { id: '600000000000000002', name: 'Member', position: 1 },
];

interface Read {
  path: string;
  fallback: unknown;
}

// Only the five members a static render reaches; the rest of ModuleForm is queries and mutations.
function formOf(values: Record<string, unknown>, reads: Read[]): ModuleForm {
  return {
    value: (path: string, fallback?: unknown) => {
      reads.push({ path, fallback });
      return Object.hasOwn(values, path) ? values[path] : fallback;
    },
    set: () => undefined,
    report: () => undefined,
    channels: CHANNELS,
    roles: ROLES,
  } as unknown as ModuleForm;
}

function render(
  node: ReactElement,
  values: Record<string, unknown> = {},
  reads: Read[] = [],
): string {
  return renderToStaticMarkup(
    <ModuleFormProvider form={formOf(values, reads)}>{node}</ModuleFormProvider>,
  );
}

// One per kind the descriptor union declares, which is what the test below checks this is.
const WRAPPERS: Record<FieldKind, ReactElement> = {
  boolean: <Toggle path="p" label="A switch" />,
  string: <Text path="p" label="Some text" />,
  number: <Num path="p" label="A number" />,
  colour: <Colour path="p" label="A colour" />,
  enum: <Choice path="p" label="A choice" options={['a', 'b']} />,
  'channel-id': <ChannelField path="p" label="A channel" />,
  'role-id': <RoleField path="p" label="A role" />,
  duration: <Duration path="p" label="A duration" />,
};

describe('the wrappers a settings page has to build a field out of', () => {
  // Was: every kind the v1 generator could emit had a component in the field registry. The registry
  // and the generator are both gone — a page names its control itself — so what has to hold now is
  // that naming one is possible for every kind a descriptor can carry.
  test('cover every kind a field descriptor can carry', () => {
    const kinds = fieldDescriptorSchema.options.map((option) => option.shape.kind.value);

    expect(Object.keys(WRAPPERS).sort()).toEqual([...kinds].sort());
  });

  test('and each renders the control for its own kind, on a row of its own', () => {
    for (const [kind, element] of Object.entries(WRAPPERS)) {
      const wanted = `<div class="field field-${kind}" data-path="p">`;

      expect(`${kind}: ${render(element).includes(wanted)}`).toBe(`${kind}: true`);
    }
  });
});

describe('rendering each supported field type', () => {
  test('boolean renders a switch reflecting its value', () => {
    const html = render(<Toggle path="enabled" label="Enabled" />, { enabled: true });

    expect(html).toContain('role="switch"');
    expect(html).toContain('checked=""');
    expect(html).toContain('Enabled');
  });

  test('string renders a text input carrying the bounds the page declares', () => {
    const html = render(<Text path="response" label="Reply text" minLength={1} maxLength={200} />, {
      response: 'Pong!',
    });

    expect(html).toContain('minLength="1"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('value="Pong!"');
  });

  // The options live in a popover that is closed until it is opened, so what the page ships is the
  // trigger. What the popover would list is channelOptions' job, and is tested with it.
  test('channel-id renders a closed picker naming the empty state', () => {
    const html = render(
      <ChannelField path="restrictToChannel" label="Restrict to channel" optional />,
    );

    expect(html).toContain('picker-trigger');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('No channel');
  });

  test('a channel-id nothing can clear says to pick one instead of naming an absence', () => {
    const html = render(<ChannelField path="logChannel" label="Log channel" />);

    expect(html).toContain('Select a channel');
    expect(html).not.toContain('No channel');
  });

  test('channel-id shows the chosen channel, with the glyph for its type', () => {
    const html = render(
      <ChannelField path="restrictToChannel" label="Restrict to channel" optional />,
      {
        restrictToChannel: '500000000000000001',
      },
    );

    expect(html).toContain('general');
    expect(html).toContain('data-icon="hash"');
  });

  test('number renders a spinner carrying the bounds the page declares', () => {
    const html = render(
      <Num path="defaultBanDeleteDays" label="Days of messages" min={0} max={7} />,
      {
        defaultBanDeleteDays: 3,
      },
    );

    expect(html).toContain('type="number"');

    expect(html).toContain('min="0"');
    expect(html).toContain('max="7"');
    expect(html).toContain('value="3"');
  });

  // Was: the generator must not hand JavaScript's own integer range down as a bound. Nothing derives
  // bounds any more, so what has to hold is that an undeclared bound stays undeclared rather than
  // arriving as some stand-in the browser would then enforce.
  test('number left unbounded carries no bound at all', () => {
    const html = render(<Num path="count" label="Count" />, { count: 1 });

    expect(html).not.toContain('min=');
    expect(html).not.toContain('max=');
    expect(html).not.toContain('9007199254740991');
  });

  test('colour renders a picker and a typable hex, both showing the stored value', () => {
    const html = render(<Colour path="accent" label="Accent colour" />, { accent: 0x5865f2 });

    expect(html).toContain('type="color"');
    expect(html.split('value="#5865f2"').length - 1).toBe(2);
    expect(html).not.toContain('type="number"');
  });

  test('a colour that is short of six digits still renders as six', () => {
    expect(render(<Colour path="accent" label="Accent" />, { accent: 0x0000ff })).toContain(
      'value="#0000ff"',
    );
  });

  test('enum renders one option per declared value', () => {
    const html = render(<Choice path="mode" label="Mode" options={['quiet', 'normal', 'loud']} />, {
      mode: 'loud',
    });

    expect(html).toContain('>Quiet<');
    expect(html).toContain('>Normal<');
    expect(html).toContain('selected=""');

    expect(html).not.toContain('Not set');
  });

  test('an optional enum offers an explicit empty choice', () => {
    expect(render(<Choice path="mode" label="Mode" options={['a', 'b']} optional />)).toContain(
      'Not set',
    );
  });

  test('role-id shows the chosen role, marked with the colour Discord gave it', () => {
    const html = render(<RoleField path="staffRole" label="Staff role" />, {
      staffRole: '600000000000000001',
    });

    expect(html).toContain('Moderator');
    expect(html).toContain('pick-dot');
    expect(html).toContain('--role-color:#5865f2');
    expect(html).not.toContain('Member');
  });

  test('duration renders the stored value and accepts it silently', () => {
    const html = render(<Duration path="escalationWindow" label="Escalation window" />, {
      escalationWindow: '30d',
    });

    expect(html).toContain('value="30d"');
    expect(html).not.toContain('is not a duration');
  });

  test('duration names the problem when the text is not one', () => {
    const html = render(<Duration path="timeout" label="Default timeout" />, {
      timeout: '1 hour',
    });

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('is not a duration');
    expect(html).toContain('30m');
  });

  test('one row per field, in the order the page writes them, as immediate siblings', () => {
    const html = render(
      <>
        <Toggle path="enabled" label="Enabled" />
        <Text path="response" label="Reply text" />
        <ChannelField path="restrictToChannel" label="Restrict to channel" optional />
      </>,
      { enabled: true, response: 'Pong!' },
    );

    expect(html.indexOf('data-path="enabled"')).toBeLessThan(html.indexOf('data-path="response"'));
    expect(html.indexOf('data-path="response"')).toBeLessThan(
      html.indexOf('data-path="restrictToChannel"'),
    );

    // `.field + .field` is the form's only row separator, so a wrapper around any of them costs the
    // hairline above every row that follows it.
    expect(html).toContain('</div><div class="field field-string"');
  });
});

describe('a list of values', () => {
  const IGNORED = (
    <Tokens path="ignoredChannels" kind="channel-id" label="Ignored channels" maxItems={50} />
  );

  test('renders one chip per element plus a way to add more', () => {
    const html = render(IGNORED, {
      ignoredChannels: ['500000000000000001', '500000000000000002'],
    });

    expect(html.split('class="token"').length - 1).toBe(2);
    expect(html).toContain('Remove general');
    expect(html).toContain('Add Ignored channels');
    expect(html).toContain('field-stacked');
  });

  test('says so rather than rendering nothing, whether it is empty or unset', () => {
    expect(render(IGNORED, { ignoredChannels: [] })).toContain('None yet.');
    expect(render(IGNORED)).toContain('None yet.');
  });

  test('a full list stops offering to add and names the limit', () => {
    const full = Array.from({ length: 50 }, () => '500000000000000001');

    expect(render(IGNORED, { ignoredChannels: full })).toContain('Limit of 50 reached');
    expect(render(IGNORED, { ignoredChannels: full })).toContain('disabled=""');
  });

  test('a list of role ids becomes chips, not text boxes', () => {
    const html = render(<Tokens path="exemptRoles" kind="role-id" label="Exempt roles" />, {
      exemptRoles: ['600000000000000001', '600000000000000002'],
    });

    expect(html).toContain('Moderator');
    expect(html).toContain('Member');
    expect(html).not.toContain('type="text"');
  });

  test('an id no longer in the guild keeps its chip, so it can still be taken off', () => {
    const html = render(<Tokens path="exemptRoles" kind="role-id" label="Exempt roles" />, {
      exemptRoles: ['600000000000000009'],
    });

    expect(html).toContain('600000000000000009');
    expect(html).toContain('data-unknown="true"');
  });

  // The kind is what decides between the two: there is nothing to pick from for a domain or a word,
  // and nothing to type for an id the guild either has or does not.
  test('a list of things the guild does not hold is typed rather than picked', () => {
    const html = render(<Tokens path="linkBlockDomains" kind="string" label="Blocked domains" />, {
      linkBlockDomains: ['example.com'],
    });

    expect(html).toContain('token-entry');
    expect(html).not.toContain('token-add');
    expect(html).not.toContain('pick-dot');
  });
});

describe('what a field reads out of the form', () => {
  test('each wrapper reads its own path, offering its declared default as the fallback', () => {
    const reads: Read[] = [];

    render(
      <>
        <Toggle path="logEdits" label="Log edits" defaultValue={true} />
        <Num path="floodCount" label="Messages" min={2} max={50} defaultValue={6} />
        <Text path="response" label="Reply text" defaultValue="Pong!" />
        <Tokens path="ignoredChannels" kind="channel-id" label="Ignored channels" />
      </>,
      {},
      reads,
    );

    expect(reads).toEqual([
      { path: 'logEdits', fallback: true },
      { path: 'floodCount', fallback: 6 },
      { path: 'response', fallback: 'Pong!' },
      { path: 'ignoredChannels', fallback: [] },
    ]);
  });

  test('a field nobody has stored a value for shows the default the page declares', () => {
    expect(render(<Toggle path="logEdits" label="Log edits" defaultValue={true} />)).toContain(
      'checked=""',
    );
    expect(render(<Text path="response" label="Reply text" defaultValue="Pong!" />)).toContain(
      'value="Pong!"',
    );
    expect(
      render(<Choice path="mode" label="Mode" options={['quiet', 'loud']} defaultValue="loud" />),
    ).toContain('<option value="loud" selected="">Loud</option>');
  });

  test('and the stored value wins over that default once there is one', () => {
    const html = render(<Toggle path="logEdits" label="Log edits" defaultValue={true} />, {
      logEdits: false,
    });

    expect(html).not.toContain('checked=""');
  });

  // Every wrapper binds through the same useBound, so a field rendered outside its page would read
  // undefined off nothing rather than saying which control was misplaced.
  test('a field rendered outside a module page says so instead of rendering blank', () => {
    expect(() => renderToStaticMarkup(<Toggle path="enabled" label="Enabled" />)).toThrow(
      'A settings field was rendered outside its ModulePage.',
    );
  });
});
