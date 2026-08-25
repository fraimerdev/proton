import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  channelOptions,
  type DiscordChannel,
  enumOptions,
  roleOptions,
  SinglePicker,
  TokenInput,
  TokenPicker,
} from '../src/components/form/picker.tsx';

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

const CHANNELS: DiscordChannel[] = [
  { id: '1', name: 'general', type: 0, parentName: 'Text' },
  { id: '2', name: 'Lounge', type: 2, parentName: 'Voice' },
  { id: '3', name: 'Stage', type: 13, parentName: 'Voice' },
  { id: '4', name: 'loose', type: 0, parentName: null },
];

const ROLES = [
  { id: '10', name: 'Moderator', position: 5, color: 0x5865f2 },
  { id: '11', name: 'Member', position: 1, color: 0 },
];

describe('channelOptions', () => {
  test('gives every channel the glyph for its type instead of a # in the label', () => {
    const [general, lounge, stage] = channelOptions(CHANNELS);

    expect(general).toMatchObject({ label: 'general', icon: 'hash' });
    expect(lounge).toMatchObject({ label: 'Lounge', icon: 'speaker-high' });
    expect(stage?.icon).toBe('microphone-stage');
  });

  test('keeps only the types the field declares', () => {
    expect(channelOptions(CHANNELS, [2, 13]).map((o) => o.label)).toEqual(['Lounge', 'Stage']);
  });

  test('carries the category as a group, and leaves an uncategorised channel ungrouped', () => {
    const byLabel = new Map(channelOptions(CHANNELS).map((o) => [o.label, o]));

    expect(byLabel.get('general')?.group).toBe('Text');
    expect(byLabel.get('loose')?.group).toBeUndefined();
  });
});

describe('roleOptions', () => {
  test('keeps the order it is given, which is highest role first', () => {
    expect(roleOptions(ROLES).map((o) => o.label)).toEqual(['Moderator', 'Member']);
  });

  test('carries the colour, and no icon, so a role reads as a dot', () => {
    const [moderator] = roleOptions(ROLES);

    expect(moderator?.colour).toBe(0x5865f2);
    expect(moderator?.icon).toBeUndefined();
  });
});

describe('enumOptions', () => {
  test('keeps the value as the id and shows a readable label, never the identifier', () => {
    expect(enumOptions(['warn', 'ban'])).toEqual([
      { id: 'warn', label: 'Warn' },
      { id: 'ban', label: 'Ban' },
    ]);
  });

  test('a compound identifier reads as words', () => {
    expect(enumOptions(['sexualContent', 'add_role', 'add-only'])).toEqual([
      { id: 'sexualContent', label: 'Sexual content' },
      { id: 'add_role', label: 'Add role' },
      { id: 'add-only', label: 'Add only' },
    ]);
  });

  test('a registered optionLabel still wins over the derived one', () => {
    expect(enumOptions(['button', 'captcha'], { button: 'Press a button' })).toEqual([
      { id: 'button', label: 'Press a button' },
      { id: 'captcha', label: 'Captcha' },
    ]);
  });
});

describe('SinglePicker', () => {
  const props = {
    id: 'x',
    label: 'Log channel',
    options: channelOptions(CHANNELS),
    onChange: () => undefined,
    emptyLabel: 'No channel',
    clearable: true,
  };

  test('ships closed, so the option list costs nothing until it is asked for', () => {
    const html = render(<SinglePicker {...props} value={null} />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('picker-value-unset');
  });

  test('names the chosen option on the trigger, with its glyph', () => {
    const html = render(<SinglePicker {...props} value="2" />);

    expect(html).toContain('Lounge');
    expect(html).toContain('data-icon="speaker-high"');
    expect(html).not.toContain('picker-value-unset');
  });

  test('a saved channel the guild no longer has keeps its raw id rather than reading as unset', () => {
    const html = render(<SinglePicker {...props} value="900000000000000009" />);

    expect(html).toContain('900000000000000009');
    expect(html).toContain('data-unknown');
    expect(html).not.toContain('No channel');
  });

  test('the missing value says so in the accessible name, not only in the styling', () => {
    const html = render(<SinglePicker {...props} value="900000000000000009" />);

    expect(html).toContain('no longer exists in this server');
  });

  test('an unset picker is still unset, not treated as a missing id', () => {
    const html = render(<SinglePicker {...props} value={null} />);

    expect(html).not.toContain('data-unknown');
    expect(html).toContain('No channel');
  });
});

describe('TokenPicker', () => {
  const props = {
    label: 'Exempt roles',
    options: roleOptions(ROLES),
    onChange: () => undefined,
  };

  test('is one chip per value and a single button to add the next', () => {
    const html = render(<TokenPicker {...props} values={['10', '11']} />);

    expect(html.split('class="token"').length - 1).toBe(2);
    expect(html.split('token-add').length - 1).toBe(1);
    expect(html).toContain('Remove Moderator');
  });

  test('says so when nothing is chosen rather than showing a bare button', () => {
    expect(render(<TokenPicker {...props} values={[]} />)).toContain('None yet.');
  });

  test('stops offering to add at the declared ceiling, and says why', () => {
    const html = render(<TokenPicker {...props} values={['10']} max={1} />);

    expect(html).toContain('Limit of 1 reached');
    expect(html).toContain('disabled=""');
  });

  test('keeps a value the guild no longer has, under its raw id', () => {
    const html = render(<TokenPicker {...props} values={['999']} />);

    expect(html).toContain('999');
    expect(html).toContain('data-unknown="true"');
  });
});

describe('TokenInput', () => {
  const props = { id: 'y', label: 'Blocked word', onChange: () => undefined, numeric: false };

  test('is chips plus one box to type the next into', () => {
    const html = render(<TokenInput {...props} values={['spam', 'scam']} />);

    expect(html.split('class="token"').length - 1).toBe(2);
    expect(html).toContain('token-entry');
    expect(html).toContain('Remove spam');
  });

  test('prompts only while the list is empty, so it does not nag once it is in use', () => {
    expect(render(<TokenInput {...props} values={[]} />)).toContain('Type and press Enter');
    expect(render(<TokenInput {...props} values={['spam']} />)).not.toContain('Type and press');
  });

  test('carries no colour dot, because a word has nothing to colour', () => {
    expect(render(<TokenInput {...props} values={['spam']} />)).not.toContain('pick-dot');
  });
});
