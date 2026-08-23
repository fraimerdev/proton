import { describe, expect, test } from 'bun:test';
import { MESSAGE_FLAG_IS_COMPONENTS_V2, sendPayloadSchema } from '@proton/core';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  COMPONENT_ACTION_ROW,
  COMPONENT_BUTTON,
  COMPONENT_CONTAINER,
  COMPONENT_MEDIA_GALLERY,
  COMPONENT_SEPARATOR,
  COMPONENT_TEXT_DISPLAY,
  claimRow,
  endedMessage,
  type GiveawayView,
  runningMessage,
  V2_FLAGS,
} from '../src/message.ts';

const VIEW: GiveawayView = {
  id: 'g1',
  title: 'A very good prize',
  description: 'Open to everybody who has been here a while.',
  bannerUrl: null,
  color: null,
  emoji: null,
  buttonStyle: BUTTON_PRIMARY,
  hostId: '400000000000000001',
  winnerCount: 2,
  endsAt: new Date('2026-08-20T12:00:00.000Z'),
  requirementLogic: 'all',
};

function render(overrides: Partial<Parameters<typeof runningMessage>[0]> = {}) {
  const result = runningMessage({
    view: VIEW,
    entrantCount: 7,
    requirements: [],
    multipliers: [],
    accentColor: 0x5865f2,
    ...overrides,
  });

  if (!result.ok) throw new Error(result.humanReason);
  return result.components;
}

function flatten(components: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];

  for (const component of components) {
    flat.push(component);
    const nested = component.components;
    if (Array.isArray(nested)) {
      flat.push(...flatten(nested as Record<string, unknown>[]));
    }
  }

  return flat;
}

describe('the Components V2 giveaway message', () => {
  test('is one container of components with no content or embeds', () => {
    const components = render();

    expect(components).toHaveLength(1);
    expect(components[0]?.type).toBe(COMPONENT_CONTAINER);
  });

  test('uses the verified component type numbers', () => {
    const types = new Set(
      flatten(render({ view: { ...VIEW, bannerUrl: 'https://x/y.png' } })).map(
        (component) => component.type,
      ),
    );

    expect(types).toContain(COMPONENT_CONTAINER);
    expect(types).toContain(COMPONENT_TEXT_DISPLAY);
    expect(types).toContain(COMPONENT_SEPARATOR);
    expect(types).toContain(COMPONENT_MEDIA_GALLERY);
    expect(types).toContain(COMPONENT_ACTION_ROW);
    expect(types).toContain(COMPONENT_BUTTON);
  });

  // Messages allow up to 40 total components under the flag.
  test('stays inside the forty-component budget', () => {
    const components = render({
      requirements: Array.from({ length: 10 }, (_unused, index) => `requirement ${index}`),
      multipliers: Array.from({ length: 10 }, (_unused, index) => `bonus ${index}`),
      view: { ...VIEW, bannerUrl: 'https://x/y.png' },
    });

    expect(flatten(components).length).toBeLessThanOrEqual(40);
  });

  test('the entry button carries a proton custom id and the count button is disabled', () => {
    const buttons = flatten(render()).filter((component) => component.type === COMPONENT_BUTTON);

    expect(buttons).toHaveLength(2);
    expect(String(buttons[0]?.custom_id)).toContain('proton:giveaways:enter:g1');
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[1]?.style).toBe(BUTTON_SECONDARY);
    expect(buttons[1]?.label).toBe('7 entrants');
  });

  test('an unsupported button style falls back to primary rather than a 400', () => {
    const buttons = flatten(render({ view: { ...VIEW, buttonStyle: 5 } })).filter(
      (component) => component.type === COMPONENT_BUTTON,
    );

    expect(buttons[0]?.style).toBe(BUTTON_PRIMARY);
  });

  test('the requirement block names whether all or any of them are needed', () => {
    const anyText = JSON.stringify(
      render({
        view: { ...VIEW, requirementLogic: 'any' },
        requirements: ['be level 5', 'be a booster'],
      }),
    );
    const allText = JSON.stringify(render({ requirements: ['be level 5', 'be a booster'] }));

    expect(anyText).toContain('any one');
    expect(allText).toContain('all');
  });

  test('a single requirement gets no any/all note', () => {
    expect(JSON.stringify(render({ requirements: ['be level 5'] }))).not.toContain('any one');
  });

  test('the ended message names the winners and drops the entry button', () => {
    const result = endedMessage({
      view: VIEW,
      entrantCount: 7,
      requirements: [],
      multipliers: [],
      accentColor: 0x5865f2,
      winnerIds: ['400000000000000002', '400000000000000003'],
    });

    if (!result.ok) throw new Error(result.humanReason);

    const text = JSON.stringify(result.components);
    expect(text).toContain('<@400000000000000002>');
    expect(flatten(result.components).some((c) => c.type === COMPONENT_BUTTON)).toBe(false);
  });

  test('an undrawn giveaway says why rather than showing an empty winner list', () => {
    const result = endedMessage({
      view: VIEW,
      entrantCount: 0,
      requirements: [],
      multipliers: [],
      accentColor: 0x5865f2,
      winnerIds: [],
    });

    if (!result.ok) throw new Error(result.humanReason);
    expect(JSON.stringify(result.components)).toContain('Nobody won');
  });

  test('the claim row is a single success button', () => {
    const result = claimRow('g1', 2);
    if (!result.ok) throw new Error(result.humanReason);

    const buttons = flatten(result.components).filter((c) => c.type === COMPONENT_BUTTON);
    expect(buttons).toHaveLength(1);
    expect(String(buttons[0]?.custom_id)).toContain('proton:giveaways:claim:g1:2');
  });
});

describe('the send payload the message goes out in', () => {
  test('the flag is bit fifteen', () => {
    expect(V2_FLAGS).toBe(MESSAGE_FLAG_IS_COMPONENTS_V2);
    expect(V2_FLAGS).toBe(1 << 15);
  });

  test('a components-only V2 send is accepted', () => {
    const parsed = sendPayloadSchema.safeParse({
      channelId: '500000000000000000',
      components: render(),
      flags: V2_FLAGS,
    });

    expect(parsed.success).toBe(true);
  });

  // Discord answers 400 for content/embeds/poll under the flag; catching it here names the field
  // instead of surfacing an opaque Bad Request from inside a debounced edit loop.
  test('a V2 send carrying content is refused before it reaches Discord', () => {
    const parsed = sendPayloadSchema.safeParse({
      channelId: '500000000000000000',
      components: render(),
      content: 'hello',
      flags: V2_FLAGS,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toContain(
        'Components V2',
      );
    }
  });

  test('a V2 send carrying embeds is refused', () => {
    const parsed = sendPayloadSchema.safeParse({
      channelId: '500000000000000000',
      components: render(),
      embeds: [{ title: 'nope' }],
      flags: V2_FLAGS,
    });

    expect(parsed.success).toBe(false);
  });

  test('a V2 send with no components at all is refused', () => {
    const parsed = sendPayloadSchema.safeParse({
      channelId: '500000000000000000',
      content: 'only text',
      flags: V2_FLAGS,
    });

    expect(parsed.success).toBe(false);
  });

  test('an ordinary send with content and embeds is untouched by the rule', () => {
    const parsed = sendPayloadSchema.safeParse({
      channelId: '500000000000000000',
      content: 'hello',
      embeds: [{ title: 'fine' }],
    });

    expect(parsed.success).toBe(true);
  });
});
