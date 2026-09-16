import type {
  SimulationAdapter,
  SimulationBuild,
  SimulationDescriptor,
  SimulationScene,
  TicketPriority,
} from '@proton/core';
import { EMPTY_MESSAGE, readInteger, readText } from '@proton/core';
import type { TicketsConfig } from './config.ts';
import {
  renderTicketChannelName,
  renderTicketText,
  TICKET_BLACKLIST_SURFACE,
  TICKET_CLOSE_SURFACE,
  TICKET_RESPONSE_SURFACE,
  TICKET_WELCOME_SURFACE,
  type TicketMessageSurface,
  type TicketPlaceholderFacts,
} from './placeholders.ts';

const TYPE_INPUT = {
  key: 'typeIndex',
  label: 'Ticket type',
  kind: 'integer',
  min: 0,
  max: 999,
  fallback: 0,
  fixed: true,
} as const;

const NUMBER_INPUT = {
  key: 'number',
  label: 'Ticket number',
  kind: 'integer',
  min: 1,
  max: 999_999,
  fallback: 42,
} as const;

const GONE = 'that ticket type is no longer in this server’s settings. Reload and try again.';

const HOUR_MS = 3_600_000;

function typeAt(config: TicketsConfig, scene: SimulationScene) {
  return config.types[readInteger(scene.inputs, 'typeIndex', 0)];
}

function factsFor(
  scene: SimulationScene,
  typeName: string,
  priority: TicketPriority,
  extra: Partial<TicketPlaceholderFacts> = {},
): TicketPlaceholderFacts {
  const number = readInteger(scene.inputs, 'number', 42);
  const ownerId = scene.subject.user.id;

  return {
    ticket: {
      id: `simulated-${number}`,
      number,
      priority,
      subject: readText(scene.inputs, 'subject', 'A sample ticket'),
      openedAt: new Date(scene.now - 2 * HOUR_MS),
      ownerId,
      openerId: ownerId,
      channelId: scene.destinationChannel?.id ?? '',
      claimedById: null,
      assignedToId: null,
    },
    typeName,
    priority,
    ownerId,
    owner: scene.subject.user,
    answers: [],
    participantCount: 2,
    actorId: scene.actor.user.id,
    actor: scene.actor.user,
    ...(scene.actor.member === 'unavailable' ? {} : { actorMember: scene.actor.member }),
    server: scene.server,
    bot: scene.bot,
    ...extra,
  };
}

function textMessage(
  surface: TicketMessageSurface,
  template: string,
  facts: TicketPlaceholderFacts,
  scene: SimulationScene,
  caption: string,
): SimulationBuild {
  const text = renderTicketText(surface, template, facts, scene.now);

  if (text.trim() === '') {
    return {
      ok: false,
      humanReason:
        'this comes out empty once its placeholders are filled in, so Proton would ' +
        'have nothing to say. Check the placeholders it uses.',
      diagnostics: [],
    };
  }

  return {
    ok: true,
    caption,
    diagnostics: [],
    output: { kind: 'message', message: { ...EMPTY_MESSAGE, content: text }, attachments: [] },
  };
}

const CARD_NOTE =
  'Proton wraps this in the ticket card when a real ticket is involved. The test posts the words ' +
  'you wrote, filled in, without that fixed chrome around them.';

const NAME_DESCRIPTOR: SimulationDescriptor = {
  id: 'tickets.channel_name',
  moduleId: 'tickets',
  label: 'Ticket channel name',
  summary: 'What a new ticket channel will be called.',
  surfaceId: 'tickets.channel_name',
  configPath: 'namePattern',
  output: 'text',
  delivery: 'none',
  subject: true,
  inputs: [TYPE_INPUT, NUMBER_INPUT],
  note: 'No ticket is opened and no channel is created — this only works out the name.',
};

export const TICKETS_NAME_SIMULATION: SimulationAdapter<TicketsConfig> = {
  descriptor: NAME_DESCRIPTOR,

  build(config, scene): SimulationBuild {
    const type = typeAt(config, scene);
    const pattern = type?.namePattern ?? config.namePattern;
    const number = readInteger(scene.inputs, 'number', 42);
    const { user, displayName } = scene.subject;

    const name = renderTicketChannelName(
      pattern,
      {
        number,
        typeName: type?.name ?? '',
        ownerId: user.id,
        owner: user,
        legacyUserName: displayName,
        server: scene.server,
      },
      scene.now,
    );

    return {
      ok: true,
      caption: `${displayName} opening ${type?.name ?? 'a'} ticket #${number}`,
      diagnostics: [],
      output: { kind: 'text', text: name },
    };
  },
};

export const TICKETS_WELCOME_SIMULATION: SimulationAdapter<TicketsConfig> = {
  descriptor: {
    id: 'tickets.welcome',
    moduleId: 'tickets',
    label: 'Ticket opening message',
    summary: 'What the member is told when their ticket opens.',
    surfaceId: TICKET_WELCOME_SURFACE.id,
    configPath: 'types.*.welcomeMessage',
    output: 'message',
    delivery: 'channel',
    subject: true,
    inputs: [TYPE_INPUT, NUMBER_INPUT],
    note: `No ticket is opened and no channel is created. ${CARD_NOTE}`,
  },

  build(config, scene): SimulationBuild {
    const type = typeAt(config, scene);
    if (type === undefined) return { ok: false, humanReason: GONE, diagnostics: [] };

    return textMessage(
      TICKET_WELCOME_SURFACE,
      type.welcomeMessage,
      factsFor(scene, type.name, type.defaultPriority),
      scene,
      `${scene.subject.displayName} opening a ${type.name} ticket`,
    );
  },
};

export const TICKETS_CLOSE_SIMULATION: SimulationAdapter<TicketsConfig> = {
  descriptor: {
    id: 'tickets.close',
    moduleId: 'tickets',
    label: 'Ticket closing message',
    summary: 'What is posted in a ticket channel when it closes.',
    surfaceId: TICKET_CLOSE_SURFACE.id,
    configPath: 'closeConfirmation',
    output: 'message',
    delivery: 'channel',
    subject: true,
    inputs: [
      TYPE_INPUT,
      NUMBER_INPUT,
      { key: 'reason', label: 'Closing reason', kind: 'text', maxLength: 200, fallback: 'Sorted' },
    ],
    note: `No ticket is closed, locked, archived or transcribed. ${CARD_NOTE}`,
  },

  build(config, scene): SimulationBuild {
    const type = typeAt(config, scene);

    const facts = factsFor(scene, type?.name ?? 'Support', type?.defaultPriority ?? 'medium', {
      close: {
        closedById: scene.actor.user.id,
        reason: readText(scene.inputs, 'reason', 'Sorted'),
      },
    });

    return textMessage(
      TICKET_CLOSE_SURFACE,
      config.closeConfirmation,
      facts,
      scene,
      `ticket #${readInteger(scene.inputs, 'number', 42)} closing`,
    );
  },
};

export const TICKETS_RESPONSE_SIMULATION: SimulationAdapter<TicketsConfig> = {
  descriptor: {
    id: 'tickets.response',
    moduleId: 'tickets',
    label: 'Quick response',
    summary: 'What staff send into a ticket with /ticket respond.',
    surfaceId: TICKET_RESPONSE_SURFACE.id,
    configPath: 'responses.*.content',
    output: 'message',
    delivery: 'channel',
    subject: true,
    inputs: [
      {
        key: 'responseIndex',
        label: 'Quick response',
        kind: 'integer',
        min: 0,
        max: 999,
        fallback: 0,
        fixed: true,
      },
      TYPE_INPUT,
      NUMBER_INPUT,
    ],
    note: 'Nothing is sent into a real ticket.',
  },

  build(config, scene): SimulationBuild {
    const response = config.responses[readInteger(scene.inputs, 'responseIndex', 0)];
    if (response === undefined) {
      return {
        ok: false,
        humanReason:
          'that quick response is no longer in this server’s settings. Reload and try again.',
        diagnostics: [],
      };
    }

    const type = typeAt(config, scene);

    return textMessage(
      TICKET_RESPONSE_SURFACE,
      response.content,
      factsFor(scene, type?.name ?? 'Support', type?.defaultPriority ?? 'medium'),
      scene,
      `'${response.label}' sent into ticket #${readInteger(scene.inputs, 'number', 42)}`,
    );
  },
};

export const TICKETS_BLACKLIST_SIMULATION: SimulationAdapter<TicketsConfig> = {
  descriptor: {
    id: 'tickets.blacklist',
    moduleId: 'tickets',
    label: 'Blacklist message',
    summary: 'What somebody who may not open tickets is told when they try.',
    surfaceId: TICKET_BLACKLIST_SURFACE.id,
    configPath: 'blacklistMessage',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [
      {
        key: 'reason',
        label: 'Blacklist reason',
        kind: 'text',
        maxLength: 200,
        fallback: 'Repeatedly opening empty tickets',
      },
    ],
    note:
      'Sent to you, never to the example member, and nobody is blacklisted by this. The real one ' +
      'is an ephemeral reply only the member who pressed the button sees, with the reason and any ' +
      'expiry added after your words.',
  },

  build(config, scene): SimulationBuild {
    const facts = factsFor(scene, 'Support', 'medium', {
      ticket: null,
      blacklist: { reason: readText(scene.inputs, 'reason', ''), expiresAt: null },
    });

    return textMessage(
      TICKET_BLACKLIST_SURFACE,
      config.blacklistMessage,
      facts,
      scene,
      `${scene.subject.displayName} turned away from opening a ticket`,
    );
  },
};

export const ticketsSimulations: SimulationAdapter<TicketsConfig>[] = [
  TICKETS_NAME_SIMULATION,
  TICKETS_WELCOME_SIMULATION,
  TICKETS_CLOSE_SIMULATION,
  TICKETS_RESPONSE_SIMULATION,
  TICKETS_BLACKLIST_SIMULATION,
];
