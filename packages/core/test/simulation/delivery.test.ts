import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { MESSAGE_CONTENT_MAX } from '../../src/interactions/respond.ts';
import { EMPTY_MESSAGE, type ProtonMessage, toDiscordMessage } from '../../src/messages/message.ts';
import { V2_COMPONENTS_MAX } from '../../src/messages/v2.ts';
import { asTestDelivery, testCustomIdFor } from '../../src/simulation/delivery.ts';

const ACTOR = '100000000000000010';

function message(overrides: Partial<ProtonMessage> = {}): ProtonMessage {
  return { ...EMPTY_MESSAGE, ...overrides };
}

describe('asTestDelivery', () => {
  test('suppresses every mention the message was allowed to make', () => {
    const { message: test } = asTestDelivery(
      message({
        content: '@everyone <@123> <@&456>',
        mentions: { everyone: true, roles: true, users: true },
      }),
      ACTOR,
    );

    expect(test.mentions).toEqual({ everyone: false, roles: false, users: false });
    expect(toDiscordMessage(test, { customIdFor: testCustomIdFor }).allowedMentions).toEqual({
      parse: [],
    });
  });

  test('disables a button that would reach a handler, and leaves a link button alone', () => {
    const { message: test } = asTestDelivery(
      message({
        content: 'hi',
        components: [
          {
            kind: 'buttons',
            buttons: [
              {
                key: 'a',
                style: 'primary',
                label: 'Press',
                action: { kind: 'reply', content: 'x', ephemeral: true },
              },
              { key: 'b', style: 'link', label: 'Open', url: 'https://prtn.xyz' },
            ],
          },
        ],
      }),
      ACTOR,
    );

    const row = test.components[0];
    if (row === undefined || row.kind !== 'buttons') throw new Error('expected a button row');

    expect(row.buttons[0]?.disabled).toBe(true);
    expect(row.buttons[1]?.disabled).toBeUndefined();
  });

  test('disables a dropdown', () => {
    const { message: test } = asTestDelivery(
      message({
        content: 'hi',
        components: [
          {
            kind: 'select',
            select: {
              key: 's',
              options: [{ key: 'one', label: 'One', action: { kind: 'reply', content: 'x', ephemeral: true } }],
            },
          },
        ],
      }),
      ACTOR,
    );

    const row = test.components[0];
    if (row === undefined || row.kind !== 'select') throw new Error('expected a select row');

    expect(row.select.disabled).toBe(true);
  });

  test('disables a button nested in a components-v2 container', () => {
    const { message: test } = asTestDelivery(
      message({
        v2: [
          {
            kind: 'container',
            children: [
              {
                kind: 'row',
                row: {
                  kind: 'buttons',
                  buttons: [{ key: 'a', style: 'secondary', label: 'Press' }],
                },
              },
            ],
          },
        ],
      }),
      ACTOR,
    );

    const container = test.v2[0];
    if (container === undefined || container.kind !== 'container') {
      throw new Error('expected a container');
    }

    const child = container.children[0];
    if (child === undefined || child.kind !== 'row' || child.row.kind !== 'buttons') {
      throw new Error('expected a button row');
    }

    expect(child.row.buttons[0]?.disabled).toBe(true);
  });

  test('marks the delivery as a test, naming who asked for it', () => {
    const { message: test, markerOmitted } = asTestDelivery(
      message({ content: 'Welcome!' }),
      ACTOR,
    );

    expect(markerOmitted).toBeUndefined();
    expect(test.content).toBe(
      `Welcome!\n-# Test message sent by <@${ACTOR}> from the Proton dashboard. Nobody was pinged.`,
    );
  });

  test('says the buttons do nothing when there are buttons', () => {
    const { message: test } = asTestDelivery(
      message({
        content: 'hi',
        components: [
          { kind: 'buttons', buttons: [{ key: 'a', style: 'secondary', label: 'Press' }] },
        ],
      }),
      ACTOR,
    );

    expect(test.content).toContain('and its buttons do nothing');
  });

  test('marks a components-v2 layout with a text display rather than content', () => {
    const { message: test, markerOmitted } = asTestDelivery(
      message({ v2: [{ kind: 'text', content: 'Body' }] }),
      ACTOR,
    );

    expect(markerOmitted).toBeUndefined();
    expect(test.content).toBeUndefined();
    expect(test.v2).toHaveLength(2);
    expect(test.v2[1]).toEqual({ kind: 'text', content: expect.stringContaining('Test message') });
  });

  test('says so rather than truncating when the message already fills Discord', () => {
    const full = 'x'.repeat(MESSAGE_CONTENT_MAX);
    const { message: test, markerOmitted } = asTestDelivery(message({ content: full }), ACTOR);

    expect(test.content).toBe(full);
    expect(markerOmitted).toContain(String(MESSAGE_CONTENT_MAX));
  });

  test('says so rather than dropping a component when the layout is full', () => {
    const v2 = Array.from({ length: V2_COMPONENTS_MAX }, (_, index) => ({
      kind: 'text' as const,
      content: `line ${index}`,
    }));

    const { message: test, markerOmitted } = asTestDelivery(message({ v2 }), ACTOR);

    expect(test.v2).toHaveLength(V2_COMPONENTS_MAX);
    expect(markerOmitted).toContain(String(V2_COMPONENTS_MAX));
  });

  test('never lets a rendered test message ping anybody, whatever it says', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (content, everyone, roles, users) => {
          const { message: test } = asTestDelivery(
            message({ content: `${content} @everyone`, mentions: { everyone, roles, users } }),
            ACTOR,
          );

          const body = toDiscordMessage(test, { customIdFor: testCustomIdFor });
          expect(body.allowedMentions).toEqual({ parse: [] });
        },
      ),
    );
  });
});

describe('testCustomIdFor', () => {
  test('namespaces to a module nothing registers, within Discord’s length cap', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 120 }), (key) => {
        const id = testCustomIdFor(key);

        expect(id.startsWith('simulation:inert:')).toBe(true);
        expect(id.length).toBeLessThanOrEqual(100);
      }),
    );
  });
});
