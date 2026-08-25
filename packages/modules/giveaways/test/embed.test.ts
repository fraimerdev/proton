import { describe, expect, test } from 'bun:test';
import { sendPayloadSchema } from '@proton/core';
import {
  type CardInput,
  cardFor,
  GIVEAWAY_CARDS,
  type GiveawayCard,
  renderCard,
} from '../src/embed.ts';
import {
  BUTTON_PRIMARY,
  COMPONENT_BUTTON,
  COMPONENT_CONTAINER,
  type GiveawayView,
  type MessageComponent,
  V2_FLAGS,
} from '../src/message.ts';

const VIEW: GiveawayView = {
  id: '01JXXXXXXXXXXXXXXXXXXXXXXX',
  shortCode: '7X29',
  status: 'running',
  title: 'Discord Nitro',
  description: 'Open to everybody who has been here a while.',
  bannerUrl: null,
  color: null,
  emoji: null,
  buttonStyle: BUTTON_PRIMARY,
  hostId: '400000000000000001',
  winnerCount: 3,
  startsAt: new Date('2026-08-26T20:00:00.000Z'),
  endsAt: new Date('2026-08-30T20:00:00.000Z'),
  requirementLogic: 'all',
};

function input(overrides: Partial<CardInput> = {}): CardInput {
  return {
    view: VIEW,
    entrantCount: 1284,
    requirements: ['Account older than 30 days', 'Member for 14 days'],
    multipliers: ['Boosters get 2 entries'],
    accentColor: 0x5865f2,
    ...overrides,
  };
}

function flatten(components: readonly MessageComponent[]): MessageComponent[] {
  const flat: MessageComponent[] = [];

  for (const component of components) {
    flat.push(component);
    const nested = component.components;
    if (Array.isArray(nested)) flat.push(...flatten(nested as MessageComponent[]));
  }

  return flat;
}

function render(card: GiveawayCard, overrides: Partial<CardInput> = {}) {
  const result = renderCard(card, input(overrides));
  if (!result.ok) throw new Error(result.humanReason);

  return result.components;
}

function buttons(components: readonly MessageComponent[]): MessageComponent[] {
  return flatten(components).filter((component) => component.type === COMPONENT_BUTTON);
}

describe('every state renders', () => {
  test.each([...GIVEAWAY_CARDS])('%s produces one container', (card: GiveawayCard) => {
    const components = render(card, { winnerIds: ['400000000000000002'] });

    expect(components).toHaveLength(1);
    expect(components[0]?.type).toBe(COMPONENT_CONTAINER);
  });

  // A Container counts every descendant against the message budget, so a card that overflows is a
  // 400 at send time rather than a layout problem.
  test.each([...GIVEAWAY_CARDS])(
    '%s stays inside the 40-component budget',
    (card: GiveawayCard) => {
      const components = render(card, {
        winnerIds: ['400000000000000002', '400000000000000003', '400000000000000004'],
        view: { ...VIEW, bannerUrl: 'https://cdn.discordapp.com/x.png' },
        requirements: Array.from({ length: 10 }, (_, index) => `requirement ${index}`),
        multipliers: Array.from({ length: 10 }, (_, index) => `multiplier ${index}`),
      });

      expect(flatten(components).length).toBeLessThanOrEqual(40);
    },
  );

  test.each([...GIVEAWAY_CARDS])('%s is a valid Components V2 send', (card: GiveawayCard) => {
    const parsed = sendPayloadSchema.safeParse({
      channelId: '500000000000000000',
      components: render(card, { winnerIds: ['400000000000000002'] }),
      flags: V2_FLAGS,
    });

    expect(parsed.success).toBe(true);
  });

  test.each([...GIVEAWAY_CARDS])('%s carries the giveaway short code', (card: GiveawayCard) => {
    expect(JSON.stringify(render(card, { winnerIds: ['400000000000000002'] }))).toContain('G-7X29');
  });
});

describe('entry controls follow the state', () => {
  test('an active card has live entry buttons', () => {
    const live = buttons(render('active'));

    expect(live.some((button) => String(button.custom_id).includes(':enter:'))).toBe(true);
    expect(live.every((button) => button.disabled === undefined)).toBe(true);
  });

  // A scheduled giveaway that still takes presses would enter members before it starts.
  test.each(['scheduled', 'paused', 'drawing'] as const)(
    'a %s card disables entry rather than dropping the row',
    (card: GiveawayCard) => {
      const entry = buttons(render(card)).filter((button) =>
        String(button.custom_id).includes(':enter:'),
      );

      expect(entry).toHaveLength(1);
      expect(entry[0]?.disabled).toBe(true);
    },
  );

  test.each(['ended', 'cancelled', 'no-winners', 'rerolled'] as const)(
    'a %s card has no buttons at all',
    (card: GiveawayCard) => {
      expect(buttons(render(card, { winnerIds: ['400000000000000002'] }))).toHaveLength(0);
    },
  );

  test('the requirements and multipliers buttons appear only when there is something to show', () => {
    const withRules = buttons(render('active')).map((button) => String(button.custom_id));
    const without = buttons(render('active', { requirements: [], multipliers: [] })).map((button) =>
      String(button.custom_id),
    );

    expect(withRules.some((id) => id.includes(':requirements:'))).toBe(true);
    expect(withRules.some((id) => id.includes(':multipliers:'))).toBe(true);
    expect(without.some((id) => id.includes(':requirements:'))).toBe(false);
    expect(without.some((id) => id.includes(':multipliers:'))).toBe(false);
  });

  test('every custom id fits Discord’s 100-character limit', () => {
    for (const card of GIVEAWAY_CARDS) {
      for (const button of buttons(render(card))) {
        expect(String(button.custom_id).length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('each state says what it is', () => {
  test('a scheduled card leads with when it starts, not when it ends', () => {
    const text = JSON.stringify(render('scheduled'));

    expect(text).toContain('Starts');
    expect(text).toContain(`<t:${Math.floor((VIEW.startsAt?.getTime() ?? 0) / 1000)}:R>`);
  });

  test('a paused card says it is paused and shows no countdown', () => {
    const text = JSON.stringify(render('paused'));

    expect(text).toContain('Paused');
    expect(text).not.toContain(`<t:${Math.floor(VIEW.endsAt.getTime() / 1000)}:R>`);
  });

  test('a paused card repeats the reason it was paused', () => {
    expect(
      JSON.stringify(render('paused', { pauseReason: 'prize supplier fell through' })),
    ).toContain('prize supplier fell through');
  });

  test('a cancelled card says nobody was drawn', () => {
    const text = JSON.stringify(render('cancelled'));

    expect(text).toContain('Cancelled');
    expect(text).toContain('Nobody was drawn');
  });

  test('an ended card medals the winners in order', () => {
    const text = JSON.stringify(
      render('ended', {
        winnerIds: ['400000000000000002', '400000000000000003', '400000000000000004'],
      }),
    );

    expect(text).toContain('🥇');
    expect(text).toContain('🥈');
    expect(text).toContain('🥉');
    expect(text.indexOf('400000000000000002')).toBeLessThan(text.indexOf('400000000000000004'));
  });

  test('an ended card keeps the requirements visible so a result can be explained', () => {
    expect(JSON.stringify(render('ended', { winnerIds: ['400000000000000002'] }))).toContain(
      'Account older than 30 days',
    );
  });

  test('a rerolled card says the winners are new', () => {
    const text = JSON.stringify(render('rerolled', { winnerIds: ['400000000000000009'] }));

    expect(text).toContain('Rerolled');
    expect(text).toContain('<@400000000000000009>');
  });

  test('a no-winners card explains itself rather than showing an empty list', () => {
    const text = JSON.stringify(render('no-winners', { winnerIds: [], entrantCount: 0 }));

    expect(text).toContain('Nobody won');
    expect(text).toContain('requirements');
  });

  // An ended giveaway with an empty winner list is the no-winners card, never a blank podium.
  test('ended with no winners falls through to the no-winners card', () => {
    expect(JSON.stringify(render('ended', { winnerIds: [] }))).toContain('Nobody won');
    expect(JSON.stringify(render('rerolled', { winnerIds: [] }))).toContain('Nobody won');
  });
});

describe('choosing the card for a status', () => {
  test.each([
    ['scheduled', [], 'scheduled'],
    ['running', [], 'active'],
    ['paused', [], 'paused'],
    ['drawing', [], 'drawing'],
    ['cancelled', [], 'cancelled'],
    ['ended', ['400000000000000002'], 'ended'],
    ['ended', [], 'no-winners'],
  ] as const)('%s with %p winners renders the %s card', (status, winners, expected) => {
    expect(cardFor(status, winners)).toBe(expected);
  });

  test('an unknown status falls back to the active card rather than throwing', () => {
    expect(cardFor('something-new')).toBe('active');
  });
});

describe('appearance carries through', () => {
  test('a custom colour beats the guild accent', () => {
    const components = render('active', { view: { ...VIEW, color: 0xff0000 } });
    expect(components[0]?.accent_color).toBe(0xff0000);
  });

  test('the guild accent is used when the giveaway sets none', () => {
    expect(render('active')[0]?.accent_color).toBe(0x5865f2);
  });

  test('a banner becomes a media gallery', () => {
    const text = JSON.stringify(
      render('active', { view: { ...VIEW, bannerUrl: 'https://cdn.discordapp.com/x.png' } }),
    );

    expect(text).toContain('https://cdn.discordapp.com/x.png');
  });

  test('a custom emoji replaces the default in the heading', () => {
    expect(JSON.stringify(render('active', { view: { ...VIEW, emoji: '🍕' } }))).toContain('🍕');
  });

  test('a giveaway with no short code falls back to its id', () => {
    expect(JSON.stringify(render('active', { view: { ...VIEW, shortCode: null } }))).toContain(
      VIEW.id,
    );
  });
});
