import { describe, expect, test } from 'bun:test';
import {
  LOG_EVENT_KEYS,
  LOG_EVENTS,
  type LogEventOverride,
  serverlogConfigSchema,
} from '@proton/module-serverlog';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogEventMatrix } from '../src/components/serverlog/event-matrix.tsx';

const CHANNELS = [
  { id: '500000000000000001', name: 'mod-log', type: 0 },
  { id: '500000000000000002', name: 'lounge', type: 2 },
  { id: '500000000000000003', name: 'announcements', type: 5 },
];

const DEFAULTS = serverlogConfigSchema.parse({});

function render(
  events: Record<string, LogEventOverride>,
  overrides: {
    defaultChannelId?: string;
    categoryChannels?: Record<string, string>;
    categories?: Record<string, boolean>;
  } = {},
): string {
  return renderToStaticMarkup(
    <LogEventMatrix
      events={events}
      channels={CHANNELS}
      defaultChannelId={overrides.defaultChannelId ?? '500000000000000001'}
      categoryChannels={overrides.categoryChannels ?? DEFAULTS.categoryChannels}
      categories={overrides.categories ?? DEFAULTS.categories}
      onChange={() => {}}
    />,
  );
}

describe('LogEventMatrix', () => {
  test('renders a row for every log in the catalogue', () => {
    const html = render({});

    for (const key of LOG_EVENT_KEYS) {
      expect(html).toContain(LOG_EVENTS[key]?.label ?? key);
    }
  });

  test('groups the logs by category', () => {
    const html = render({});

    expect(html).toContain('Members');
    expect(html).toContain('Moderation');
    expect(html).toContain('Channels');
    expect(html).toContain('Roles');
  });

  test('the summary counts what is actually on, resolved through the category', () => {
    const members = LOG_EVENT_KEYS.filter((key) => LOG_EVENTS[key]?.category === 'members').length;
    const html = render({});

    expect(html).toContain(`${members} of ${members} on`);
  });

  test('a category that is off counts as none on', () => {
    const members = LOG_EVENT_KEYS.filter((key) => LOG_EVENTS[key]?.category === 'members').length;
    const html = render({}, { categories: { ...DEFAULTS.categories, members: false } });

    expect(html).toContain(`0 of ${members} on`);
  });

  test('a single log turned on counts even when its category is off', () => {
    const members = LOG_EVENT_KEYS.filter((key) => LOG_EVENTS[key]?.category === 'members').length;
    const html = render(
      { 'members.joined': { enabled: true } },
      { categories: { ...DEFAULTS.categories, members: false } },
    );

    expect(html).toContain(`1 of ${members} on`);
  });

  test('the summary names where the category’s logs will land', () => {
    const html = render({});

    expect(html).toContain('#mod-log');
  });

  test('a per-category channel is shown instead of the default', () => {
    const html = render(
      {},
      {
        categoryChannels: { ...DEFAULTS.categoryChannels, members: '500000000000000003' },
      },
    );

    expect(html).toContain('#announcements');
  });

  test('an unconfigured guild says the logs go nowhere', () => {
    const html = render({}, { defaultChannelId: '' });

    expect(html).toContain('nowhere');
  });

  test('only text channels are offered as destinations', () => {
    const html = render({});

    expect(html).toContain('#mod-log');
    expect(html).toContain('#announcements');
    expect(html).not.toContain('#lounge');
  });

  test('the inherit option names the channel it would inherit', () => {
    expect(render({})).toContain('Inherit — #mod-log');
  });

  test('a stored override is reflected in its row', () => {
    const html = render({ 'members.joined': { enabled: false } });

    expect(html).toContain('Member joined');
    expect(html).toMatch(/selected[^>]*>Off|<option value="off" selected/);
  });

  test('every rendered key is one the config schema accepts', () => {
    const events = Object.fromEntries(LOG_EVENT_KEYS.map((key) => [key, { enabled: true }]));

    expect(serverlogConfigSchema.safeParse({ events }).success).toBe(true);
    expect(render(events)).toContain('Member joined');
  });
});
