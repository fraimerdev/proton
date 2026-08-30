import { describe, expect, test } from 'bun:test';
import type { Counter } from '@proton/module-counters/config';
import { renderToStaticMarkup } from 'react-dom/server';
import { CountersEditor } from '../src/components/counters/counters.tsx';
import type { DiscordChannel } from '../src/components/form/picker.tsx';

const CHANNELS: DiscordChannel[] = [
  { id: '500000000000000001', name: 'general', type: 0, parentName: null },
];

const OWNED: Counter = { id: 'aaa', template: 'Members: {count}', source: 'members' };

const POINTED: Counter = {
  id: 'bbb',
  channelId: '500000000000000001',
  template: 'Members: {count}',
  source: 'members',
};

function render(counters: Counter[]): string {
  return renderToStaticMarkup(
    <CountersEditor counters={counters} channels={CHANNELS} tier="free" onChange={() => {}} />,
  );
}

describe('CountersEditor', () => {
  test('says Proton makes the channel, rather than asking for one first', () => {
    expect(render([])).toContain('Proton makes each counter its own voice channel');
  });

  test('a counter Proton owns shows no channel picker to fill in', () => {
    const html = render([OWNED]);

    expect(html).toContain('Proton makes it');
    expect(html).not.toContain('Choose a channel…');
  });

  test('a counter pointed at an existing channel still picks one', () => {
    expect(render([POINTED])).toContain('general');
  });

  test('an unfilled channel is flagged rather than saved blank', () => {
    expect(render([{ ...POINTED, channelId: '' }])).toContain('Choose a channel…');
  });

  test('an empty list says nothing is renamed rather than showing an empty table', () => {
    expect(render([])).toContain('No counters');
  });
});
