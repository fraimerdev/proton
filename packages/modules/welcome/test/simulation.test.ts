import { describe, expect, test } from 'bun:test';
import type { SimulationScene } from '@proton/core';
import { personFor } from '@proton/core';
import { SAMPLE_BOT, SAMPLE_MEMBER, SAMPLE_NOW, SAMPLE_SERVER } from '@proton/core/placeholders';
import { welcomeConfigSchema } from '../src/config.ts';
import { welcomeModule } from '../src/index.ts';
import {
  renderGreetingMessage,
  WELCOME_JOIN_SURFACE,
  WELCOME_LEAVE_SURFACE,
} from '../src/placeholders.ts';
import {
  WELCOME_BOOST_SIMULATION,
  WELCOME_JOIN_SIMULATION,
  WELCOME_LEAVE_SIMULATION,
  welcomeSimulations,
} from '../src/simulation.ts';

const CHANNEL = { id: '100000000000000040', name: 'welcome', type: 0, parentId: null };

function scene(overrides: Partial<SimulationScene> = {}): SimulationScene {
  const subject = personFor(SAMPLE_MEMBER.user, SAMPLE_MEMBER.member);

  return {
    guildId: SAMPLE_SERVER.id,
    server: SAMPLE_SERVER,
    guildState: null,
    subject,
    actor: subject,
    destinationChannel: CHANNEL,
    originChannel: CHANNEL,
    bot: SAMPLE_BOT,
    eventId: '01J8Z3K5N2V7Q4R6T8W0X2Y4Z6',
    now: SAMPLE_NOW,
    tier: 'free',
    inputs: {},
    ...overrides,
  };
}

const config = welcomeConfigSchema.parse({
  welcomeChannelId: '100000000000000040',
  goodbyeChannelId: '100000000000000041',
  welcomeMessage: { content: 'Welcome {user}, member #{memberCount} of {server}.' },
  goodbyeMessage: { content: '{username} left. They joined {user.joined_at}.' },
  boostMessage: {
    content: 'Thanks {user} — {server.boost_count} boosts at level {server.boost_tier}.',
  },
});

describe('the manifest', () => {
  test('declares every greeting, each pointing at its own surface', () => {
    expect(welcomeModule.simulations).toBe(welcomeSimulations);
    expect(welcomeSimulations.map(({ descriptor }) => descriptor.id)).toEqual([
      'welcome.join',
      'welcome.leave',
      'welcome.boost',
    ]);

    for (const { descriptor } of welcomeSimulations) {
      expect(welcomeModule.templates?.surfaces[descriptor.surfaceId ?? '']).toBeDefined();
    }
  });

  test('sends each greeting where its own setting says', () => {
    expect(WELCOME_JOIN_SIMULATION.destination?.(config)).toBe('100000000000000040');
    expect(WELCOME_LEAVE_SIMULATION.destination?.(config)).toBe('100000000000000041');
    expect(WELCOME_BOOST_SIMULATION.destination?.(config)).toBeNull();
  });
});

describe('rendering', () => {
  test('a join renders exactly what the listener renders from the same facts', () => {
    const built = WELCOME_JOIN_SIMULATION.build(config, scene());
    if (!built.ok) throw new Error(built.humanReason);

    const direct = renderGreetingMessage(
      config.welcomeMessage,
      WELCOME_JOIN_SURFACE,
      {
        user: SAMPLE_MEMBER.user,
        member: SAMPLE_MEMBER.member,
        server: SAMPLE_SERVER,
        destinationChannel: CHANNEL,
        bot: SAMPLE_BOT,
        eventId: '01J8Z3K5N2V7Q4R6T8W0X2Y4Z6',
        occurredAt: SAMPLE_NOW,
      },
      SAMPLE_NOW,
    );

    if (!direct.ok) throw new Error(direct.humanReason);
    if (built.output.kind !== 'message') throw new Error('expected a message');

    expect(built.output.message).toEqual(direct.message);
  });

  test('a leave renders with the member gone, without the member leaving', () => {
    const built = WELCOME_LEAVE_SIMULATION.build(config, scene());
    if (!built.ok || built.output.kind !== 'message') throw new Error('expected a message');

    const direct = renderGreetingMessage(
      config.goodbyeMessage,
      WELCOME_LEAVE_SURFACE,
      {
        user: SAMPLE_MEMBER.user,
        member: 'unavailable',
        server: SAMPLE_SERVER,
        destinationChannel: CHANNEL,
        bot: SAMPLE_BOT,
        eventId: '01J8Z3K5N2V7Q4R6T8W0X2Y4Z6',
        occurredAt: SAMPLE_NOW,
      },
      SAMPLE_NOW,
    );

    if (!direct.ok) throw new Error(direct.humanReason);
    expect(built.output.message).toEqual(direct.message);
    expect(built.output.message.content).toContain('left.');
  });

  test('a boost uses the counts the dialog was given, not the ones the server has', () => {
    const built = WELCOME_BOOST_SIMULATION.build(
      config,
      scene({ inputs: { boostCount: 42, boostTier: 3 } }),
    );

    if (!built.ok || built.output.kind !== 'message') throw new Error('expected a message');
    expect(built.output.message.content).toBe(
      'Thanks <@100000000000000010> — 42 boosts at level 3.',
    );
  });

  test('a boost falls back to the server’s real counts when nothing is given', () => {
    const built = WELCOME_BOOST_SIMULATION.build(config, scene());

    if (!built.ok || built.output.kind !== 'message') throw new Error('expected a message');
    expect(built.output.message.content).toContain('14 boosts at level 2');
  });

  test('refuses an empty greeting rather than posting nothing', () => {
    const silent = welcomeConfigSchema.parse({ welcomeMessage: { content: '' } });
    const built = WELCOME_JOIN_SIMULATION.build(silent, scene());

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.humanReason).toContain('empty');
  });

  test('attaches the card only when the card is switched on', () => {
    const withCard = welcomeConfigSchema.parse({ ...config, card: true });
    const built = WELCOME_JOIN_SIMULATION.build(withCard, scene());

    if (!built.ok || built.output.kind !== 'message') throw new Error('expected a message');
    expect(built.output.attachments).toHaveLength(1);
    expect(built.output.attachments[0]?.filename).toBe('welcome.png');
    expect(built.output.attachments[0]?.card.memberCount).toBe(SAMPLE_SERVER.memberCount);

    const without = WELCOME_JOIN_SIMULATION.build(config, scene());
    if (!without.ok || without.output.kind !== 'message') throw new Error('expected a message');
    expect(without.output.attachments).toEqual([]);
  });

  test('renders with no channel chosen rather than refusing', () => {
    const built = WELCOME_JOIN_SIMULATION.build(config, scene({ destinationChannel: null }));

    expect(built.ok).toBe(true);
  });

  test('leaves the config it was handed untouched', () => {
    const before = structuredClone(config);
    WELCOME_JOIN_SIMULATION.build(config, scene());
    WELCOME_LEAVE_SIMULATION.build(config, scene());
    WELCOME_BOOST_SIMULATION.build(config, scene({ inputs: { boostCount: 9 } }));

    expect(config).toEqual(before);
  });
});
