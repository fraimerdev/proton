import {
  type AllowedMentions,
  type Attachment,
  type AutocompleteChoice,
  INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_UPDATE,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  type Modal,
} from '../actions/payloads.ts';
import type { ActionRequest } from '../actions/types.ts';
import type { InteractionBase } from './read.ts';

export const MESSAGE_CONTENT_MAX = 2000;

export interface InteractionRef {
  id: string;
  token: string;

  type?: number;
}

export function interactionRef(facts: InteractionBase): InteractionRef {
  return { id: facts.interactionId, token: facts.token, type: facts.type };
}

export interface RespondTo {
  guildId: string;
  moduleId: string;
  actorId: string;
  interaction: InteractionRef;

  idempotencyKey?: string;
}

export interface FollowUpTo extends RespondTo {
  applicationId: string;
}

export interface InteractionMessage {
  content?: string;
  embeds?: Record<string, unknown>[];
  components?: Record<string, unknown>[];
  files?: Attachment[];
  ephemeral?: boolean;

  // Only IS_COMPONENTS_V2 in practice, and it is or'd with the ephemeral bit rather than replacing
  // it. A reply, an update and a followup all carry it; only a DEFERRED callback cannot.
  flags?: number;

  allowedMentions?: AllowedMentions;
}

export type MessageInput = string | InteractionMessage;

function messageOf(input: MessageInput): InteractionMessage {
  const message = typeof input === 'string' ? { content: input } : input;
  if (message.content === undefined) return message;

  // Past 2000 the payload schema refuses the whole reply, so the member would be told nothing at
  // all rather than a little less.
  return { ...message, content: message.content.slice(0, MESSAGE_CONTENT_MAX) };
}

function present(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function keyFor(to: RespondTo, suffix: string): string {
  // The override scopes the key; replacing the suffix would collide a defer with its follow-up.
  return `${to.idempotencyKey ?? `${to.moduleId}:${to.interaction.id}`}:${suffix}`;
}

function reply(
  to: RespondTo,
  suffix: string,
  data: Record<string, unknown>,
  callbackType: number,
): ActionRequest {
  return {
    guildId: to.guildId,
    moduleId: to.moduleId,
    kind: 'interaction_reply',
    actorId: to.actorId,
    dryRun: false,
    idempotencyKey: keyFor(to, suffix),
    // Acknowledging an interaction is not a moderation case, and autocomplete fires per keystroke.
    record: false,
    payload: present({
      interactionId: to.interaction.id,
      interactionToken: to.interaction.token,
      callbackType,
      ...data,
    }),
  };
}

export function deferEphemeral(to: RespondTo): ActionRequest {
  return reply(to, 'defer', { ephemeral: true }, INTERACTION_CALLBACK_DEFERRED_MESSAGE);
}

export function deferUpdate(to: RespondTo): ActionRequest {
  return reply(to, 'defer-update', {}, INTERACTION_CALLBACK_DEFERRED_UPDATE);
}

export function replyEphemeral(to: RespondTo, input: MessageInput): ActionRequest {
  const message = messageOf(input);

  return reply(
    to,
    'reply',
    {
      content: message.content,
      embeds: message.embeds,
      components: message.components,
      files: message.files,
      flags: message.flags,
      allowedMentions: message.allowedMentions,
      ephemeral: true,
    },
    INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  );
}

export function updateMessage(to: RespondTo, input: MessageInput): ActionRequest {
  const message = messageOf(input);

  return reply(
    to,
    'update',
    {
      content: message.content,
      embeds: message.embeds,
      components: message.components,
      files: message.files,
      flags: message.flags,
      allowedMentions: message.allowedMentions,
    },
    INTERACTION_CALLBACK_UPDATE_MESSAGE,
  );
}

export function openModal(to: RespondTo, modal: Modal): ActionRequest {
  return reply(
    to,
    `modal:${modal.customId}`,
    { modal, sourceInteractionType: to.interaction.type },
    INTERACTION_CALLBACK_MODAL,
  );
}

export function respondAutocomplete(
  to: RespondTo,
  choices: readonly AutocompleteChoice[],
): ActionRequest {
  return reply(
    to,
    'autocomplete',
    { choices: [...choices] },
    INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  );
}

export function followUp(to: FollowUpTo, input: MessageInput): ActionRequest {
  const message = messageOf(input);

  return {
    guildId: to.guildId,
    moduleId: to.moduleId,
    kind: 'interaction_followup',
    actorId: to.actorId,
    dryRun: false,
    idempotencyKey: keyFor(to, 'followup'),
    record: false,
    payload: present({
      applicationId: to.applicationId,
      interactionToken: to.interaction.token,
      content: message.content,
      embeds: message.embeds,
      components: message.components,
      files: message.files,
      flags: message.flags,
      allowedMentions: message.allowedMentions,
      ephemeral: message.ephemeral ?? true,
    }),
  };
}
