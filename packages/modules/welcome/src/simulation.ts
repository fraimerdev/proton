import type {
  SimulationAdapter,
  SimulationAttachment,
  SimulationBuild,
  SimulationDescriptor,
  SimulationScene,
} from '@proton/core';
import { readInteger, unavailableMember } from '@proton/core';
import type { PlaceholderSurface } from '@proton/core/placeholders';
import { type GreetingMessage, isSilentGreeting, type WelcomeConfig } from './config.ts';
import {
  type GreetingOccasion,
  type GreetingPlaceholderFacts,
  renderGreetingMessage,
  WELCOME_BOOST_SURFACE,
  WELCOME_JOIN_SURFACE,
  WELCOME_LEAVE_SURFACE,
} from './placeholders.ts';

const NOTHING_TO_POST =
  'this message is empty and no card is attached, so a real event would post nothing. Write ' +
  'something or turn on the card first.';

interface Occasion {
  surface: PlaceholderSurface<GreetingPlaceholderFacts>;
  descriptor: SimulationDescriptor;
  card: 'welcome' | 'goodbye' | null;
  channel(config: WelcomeConfig): string | null;
  message(config: WelcomeConfig): GreetingMessage;
}

const OCCASIONS: Record<GreetingOccasion, Occasion> = {
  join: {
    surface: WELCOME_JOIN_SURFACE,
    card: 'welcome',
    channel: (config) => config.welcomeChannelId ?? null,
    message: (config) => config.welcomeMessage,
    descriptor: {
      id: 'welcome.join',
      moduleId: 'welcome',
      label: 'Welcome message',
      summary: 'What Proton posts when a member joins.',
      surfaceId: WELCOME_JOIN_SURFACE.id,
      configPath: 'welcomeMessage',
      output: 'message',
      delivery: 'channel',
      channelPath: 'welcomeChannelId',
      subject: true,
      inputs: [],
    },
  },
  leave: {
    surface: WELCOME_LEAVE_SURFACE,
    card: 'goodbye',
    channel: (config) => config.goodbyeChannelId ?? null,
    message: (config) => config.goodbyeMessage,
    descriptor: {
      id: 'welcome.leave',
      moduleId: 'welcome',
      label: 'Goodbye message',
      summary: 'What Proton posts when a member leaves.',
      surfaceId: WELCOME_LEAVE_SURFACE.id,
      configPath: 'goodbyeMessage',
      output: 'message',
      delivery: 'channel',
      channelPath: 'goodbyeChannelId',
      subject: true,
      inputs: [],
      note:
        'Nobody actually leaves. The test only uses what Proton still knows after a member ' +
        'leaves, so their nickname, roles and join date come out empty, just like a real goodbye.',
    },
  },
  boost: {
    surface: WELCOME_BOOST_SURFACE,
    card: null,
    channel: (config) => config.boostChannelId ?? null,
    message: (config) => config.boostMessage,
    descriptor: {
      id: 'welcome.boost',
      moduleId: 'welcome',
      label: 'Boost message',
      summary: 'What Proton posts when a member boosts the server.',
      surfaceId: WELCOME_BOOST_SURFACE.id,
      configPath: 'boostMessage',
      output: 'message',
      delivery: 'channel',
      channelPath: 'boostChannelId',
      subject: true,
      inputs: [
        {
          key: 'boostCount',
          label: 'Boosts the server has',
          kind: 'integer',
          min: 0,
          max: 1000,
          fallback: 14,
        },
        {
          key: 'boostTier',
          label: 'Boost level',
          kind: 'integer',
          min: 0,
          max: 3,
          fallback: 2,
        },
      ],
      note:
        'No boost is recorded, and the server’s real boosts don’t change. With no boost channel ' +
        'set, a real boost message goes where Discord posts its boost notice, so choose a channel ' +
        'for the test.',
    },
  },
};

function factsFor(occasion: GreetingOccasion, scene: SimulationScene): GreetingPlaceholderFacts {
  const person = occasion === 'leave' ? unavailableMember(scene.subject) : scene.subject;

  const member =
    occasion === 'boost' && person.member !== 'unavailable'
      ? { ...person.member, premiumSince: new Date(scene.now).toISOString() }
      : person.member;

  const server =
    occasion === 'boost' && scene.server !== null
      ? {
          ...scene.server,
          boostCount: readInteger(scene.inputs, 'boostCount', scene.server.boostCount ?? 0),
          boostTier: readInteger(scene.inputs, 'boostTier', scene.server.boostTier ?? 0),
        }
      : scene.server;

  return {
    user: person.user,
    member,
    server,
    ...(occasion === 'boost'
      ? { channel: scene.originChannel ?? scene.destinationChannel ?? undefined }
      : {}),
    destinationChannel: scene.destinationChannel,
    bot: scene.bot,
    eventId: scene.eventId,
    occurredAt: scene.now,
  };
}

function cardsFor(
  kind: 'welcome' | 'goodbye' | null,
  config: WelcomeConfig,
  scene: SimulationScene,
): SimulationAttachment[] {
  if (kind === null || !config.card) return [];

  const { user } = scene.subject;

  return [
    {
      filename: `${kind}.png`,
      card: {
        kind,
        preset: config.preset,
        accent: config.cardAccent,
        displayName: scene.subject.displayName,
        showMemberCount: config.cardShowMemberCount,
        ...(scene.server?.memberCount === undefined
          ? {}
          : { memberCount: scene.server.memberCount }),
        ...(config.cardBackgroundUrl ? { background: config.cardBackgroundUrl } : {}),
        ...(scene.server?.name === undefined ? {} : { guildName: scene.server.name }),
        ...(user.avatarHash === null
          ? {}
          : {
              avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatarHash}.png?size=256`,
            }),
      },
    },
  ];
}

function buildFor(occasion: GreetingOccasion) {
  const { surface, message: pick, card } = OCCASIONS[occasion];

  return (config: WelcomeConfig, scene: SimulationScene): SimulationBuild => {
    const message = pick(config);
    const attachments = cardsFor(card, config, scene);

    if (isSilentGreeting(message) && attachments.length === 0) {
      return { ok: false, humanReason: NOTHING_TO_POST, diagnostics: [] };
    }

    const rendered = renderGreetingMessage(message, surface, factsFor(occasion, scene), scene.now);

    if (!rendered.ok) {
      return { ok: false, humanReason: rendered.humanReason, diagnostics: rendered.diagnostics };
    }

    return {
      ok: true,
      caption: `${scene.subject.displayName} in ${scene.server?.name ?? 'this server'}`,
      diagnostics: rendered.diagnostics,
      output: { kind: 'message', message: rendered.message, attachments },
    };
  };
}

function adapterFor(occasion: GreetingOccasion): SimulationAdapter<WelcomeConfig> {
  const { descriptor, channel } = OCCASIONS[occasion];

  return { descriptor, destination: channel, build: buildFor(occasion) };
}

export const WELCOME_JOIN_SIMULATION = adapterFor('join');

export const WELCOME_LEAVE_SIMULATION = adapterFor('leave');

export const WELCOME_BOOST_SIMULATION = adapterFor('boost');

export const welcomeSimulations: SimulationAdapter<WelcomeConfig>[] = [
  WELCOME_JOIN_SIMULATION,
  WELCOME_LEAVE_SIMULATION,
  WELCOME_BOOST_SIMULATION,
];
