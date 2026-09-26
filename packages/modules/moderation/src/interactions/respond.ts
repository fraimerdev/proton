import {
  type ActionRequest,
  type ActionResult,
  type AllowedMentions,
  deferEphemeral,
  encodeCustomId,
  type FollowUpTo,
  followUp,
  type InteractionMessage,
  type InteractionRef,
  type ModuleContext,
  type RespondTo,
  replyEphemeral,
  type StatusBody,
  updateMessage,
} from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { MODULE_ID } from '../perform.ts';

type Answering = Pick<ModuleContext, 'guildId' | 'executor' | 'logger'>;

export const CONFIRM_ACTION = 'pgo';
export const CANCEL_ACTION = 'pstop';

export const WORKING = 'Working on it…';
export const CANCELLED = 'Cancelled.';

const NO_MENTIONS: AllowedMentions = { parse: [] };

export function respondTo(
  guildId: string,
  actorId: string,
  interaction: InteractionRef,
  idempotencyKey?: string,
): RespondTo {
  return {
    guildId,
    moduleId: MODULE_ID,
    actorId,
    interaction,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export async function send(ctx: Answering, request: ActionRequest): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `moderation could not answer an interaction: ${
        result.failure?.humanReason ?? 'Discord gave no reason.'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

export function acknowledged(result: ActionResult): boolean {
  return result.status !== 'failed_precheck' && result.status !== 'failed_api';
}

function visible(request: ActionRequest, ephemeral: boolean): ActionRequest {
  if (ephemeral) return request;
  return { ...request, payload: { ...(request.payload as Record<string, unknown>), ephemeral } };
}

export function deferTo(to: RespondTo, ephemeral: boolean): ActionRequest {
  return visible(deferEphemeral(to), ephemeral);
}

export function replyTo(
  to: RespondTo,
  message: InteractionMessage,
  ephemeral = true,
): ActionRequest {
  return visible(replyEphemeral(to, message), ephemeral);
}

export function updateTo(to: RespondTo, message: InteractionMessage): ActionRequest {
  return updateMessage(to, message);
}

export function followUpTo(
  to: FollowUpTo,
  message: InteractionMessage,
  suffix: string,
  ephemeral = true,
): ActionRequest {
  const request = followUp(to, { ...message, ephemeral });
  return { ...request, idempotencyKey: `${request.idempotencyKey}:${suffix}` };
}

export function statusMessage(
  body: StatusBody,
  components: Record<string, unknown>[] = [],
): InteractionMessage {
  return {
    content: body.content,
    embeds: body.embeds,
    components,
    allowedMentions: NO_MENTIONS,
  };
}

export function textMessage(
  text: string,
  components: Record<string, unknown>[] = [],
): InteractionMessage {
  return { content: text, embeds: [], components, allowedMentions: NO_MENTIONS };
}

export function withCase(text: string, caseId: string | null | undefined): string {
  return caseId ? `${text}\n-# Case \`${caseId}\`` : text;
}

export interface ConfirmOptions {
  confirmLabel?: string;
  danger?: boolean;
}

export function confirmRow(
  pendingId: string,
  options: ConfirmOptions = {},
): Record<string, unknown> | null {
  const go = encodeCustomId(MODULE_ID, CONFIRM_ACTION, pendingId);
  const stop = encodeCustomId(MODULE_ID, CANCEL_ACTION, pendingId);
  if (!go.ok || !stop.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: options.danger ? ButtonStyle.Danger : ButtonStyle.Primary,
        label: options.confirmLabel ?? 'Continue',
        custom_id: go.customId,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: 'Cancel',
        custom_id: stop.customId,
      },
    ],
  };
}

export function confirmPrompt(
  text: string,
  pendingId: string,
  options: ConfirmOptions = {},
): InteractionMessage | null {
  const row = confirmRow(pendingId, options);
  return row ? textMessage(text, [row]) : null;
}
