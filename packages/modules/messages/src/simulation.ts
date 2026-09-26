import type {
  SimulationAdapter,
  SimulationBuild,
  SimulationDescriptor,
  SimulationScene,
} from '@proton/core';
import { readInteger } from '@proton/core';
import type { PlaceholderSurface } from '@proton/core/placeholders';
import type { MessagesConfig, SavedMessage } from './config.ts';
import {
  MESSAGES_POST_SURFACE,
  MESSAGES_SCHEDULED_SURFACE,
  type MessagesPlaceholderFacts,
  renderSavedMessage,
} from './placeholders.ts';

const GONE = 'that template is no longer in this server’s settings. Reload the page and try again.';

const TEMPLATE_INPUT = {
  key: 'templateIndex',
  label: 'Template',
  kind: 'integer',
  min: 0,
  max: 999,
  fallback: 0,
  fixed: true,
} as const;

function factsFor(scene: SimulationScene, scheduled: boolean): MessagesPlaceholderFacts {
  const member = scene.actor.member === 'unavailable' ? null : scene.actor.member;

  return {
    server: scene.server,
    bot: scene.bot,
    destinationChannel: scene.destinationChannel,
    // Null on the scheduled surface, which is the whole point of it having its own: a scheduled
    // post has nobody who ran the command, and the actor keys must refuse rather than resolve.
    actor: scheduled ? null : { user: scene.actor.user, member },
  };
}

function templateAt(config: MessagesConfig, scene: SimulationScene): SavedMessage | undefined {
  return config.templates[readInteger(scene.inputs, 'templateIndex', 0)];
}

function buildFor(
  surface: PlaceholderSurface<MessagesPlaceholderFacts>,
  scheduled: boolean,
): SimulationAdapter<MessagesConfig>['build'] {
  return (config, scene): SimulationBuild => {
    const template = templateAt(config, scene);
    if (template === undefined) return { ok: false, humanReason: GONE, diagnostics: [] };

    const rendered = renderSavedMessage(template, surface, factsFor(scene, scheduled), scene.now);

    if (!rendered.ok) {
      return { ok: false, humanReason: rendered.humanReason, diagnostics: rendered.diagnostics };
    }

    return {
      ok: true,
      caption: scheduled
        ? `'${template.name}' posting on its schedule`
        : `${scene.actor.displayName} posting '${template.name}'`,
      diagnostics: rendered.diagnostics,
      output: { kind: 'message', message: rendered.message, attachments: [] },
    };
  };
}

const POST_DESCRIPTOR: SimulationDescriptor = {
  id: 'messages.post',
  moduleId: 'messages',
  label: 'Template',
  summary: 'What /message post puts in a channel.',
  surfaceId: MESSAGES_POST_SURFACE.id,
  configPath: 'templates.*',
  output: 'message',
  delivery: 'channel',
  subject: false,
  inputs: [TEMPLATE_INPUT],
  note:
    'Posted as a test wherever you choose, with its buttons and dropdowns disabled. A real ' +
    '/message post puts the live ones in the channel you name on the command.',
};

const SCHEDULED_DESCRIPTOR: SimulationDescriptor = {
  id: 'messages.scheduled',
  moduleId: 'messages',
  label: 'Scheduled post',
  summary: 'What this template looks like when its schedule posts it.',
  surfaceId: MESSAGES_SCHEDULED_SURFACE.id,
  configPath: 'templates.*',
  output: 'message',
  delivery: 'channel',
  subject: false,
  inputs: [TEMPLATE_INPUT],
  note:
    'Filled in the way the schedule fills it in, so placeholders about who ran the command come ' +
    'out empty. The schedule isn’t changed and the ping role isn’t pinged.',
};

export const MESSAGES_POST_SIMULATION: SimulationAdapter<MessagesConfig> = {
  descriptor: POST_DESCRIPTOR,
  build: buildFor(MESSAGES_POST_SURFACE, false),
};

export const MESSAGES_SCHEDULED_SIMULATION: SimulationAdapter<MessagesConfig> = {
  descriptor: SCHEDULED_DESCRIPTOR,
  destination: (config, inputs) =>
    config.templates[readInteger(inputs, 'templateIndex', 0)]?.schedule?.channelId ?? null,
  build: buildFor(MESSAGES_SCHEDULED_SURFACE, true),
};

export const messagesSimulations: SimulationAdapter<MessagesConfig>[] = [
  MESSAGES_POST_SIMULATION,
  MESSAGES_SCHEDULED_SIMULATION,
];
