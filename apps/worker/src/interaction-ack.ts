import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_UPDATE,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  isScopedActionExecutor,
  type ScopedActionExecutor,
} from '@proton/core';
import { MessageFlags, RESTJSONErrorCodes } from 'discord-api-types/v10';

const INITIAL_CALLBACKS: ReadonlySet<unknown> = new Set([
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_UPDATE,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  INTERACTION_CALLBACK_MODAL,
]);

export function acknowledges(
  request: ActionRequest,
  result: ActionResult,
  interactionId: string,
): boolean {
  if (request.kind !== 'interaction_reply') return false;

  const payload = (request.payload ?? {}) as { interactionId?: unknown; callbackType?: unknown };
  if (payload.interactionId !== interactionId) return false;
  if (!INITIAL_CALLBACKS.has(payload.callbackType ?? INTERACTION_CALLBACK_CHANNEL_MESSAGE)) {
    return false;
  }

  // A duplicate is the same callback an earlier delivery already made.
  return (
    result.status === 'executed' ||
    result.status === 'skipped_duplicate' ||
    result.failure?.discordCode === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged
  );
}

export function defersPublicly(request: ActionRequest): boolean {
  const payload = (request.payload ?? {}) as {
    callbackType?: unknown;
    ephemeral?: unknown;
    flags?: unknown;
  };
  const flagged =
    typeof payload.flags === 'number' && (payload.flags & MessageFlags.Ephemeral) !== 0;
  return (
    payload.callbackType === INTERACTION_CALLBACK_DEFERRED_MESSAGE &&
    payload.ephemeral !== true &&
    !flagged
  );
}

function followsUp(request: ActionRequest, result: ActionResult, token: string): boolean {
  if (request.kind !== 'interaction_followup') return false;
  const payload = (request.payload ?? {}) as { interactionToken?: unknown };
  return (
    payload.interactionToken === token &&
    (result.status === 'executed' || result.status === 'skipped_duplicate')
  );
}

export interface AcknowledgementWatch {
  executor: ActionExecutor;
  acknowledged(): boolean;
  publicDeferOpen(): boolean;
}

export function watchAcknowledgement(
  executor: ActionExecutor,
  interaction: { id: string; token: string },
): AcknowledgementWatch {
  const seen = { acknowledged: false, publicDefer: false, followedUp: false };

  const wrap = (inner: ActionExecutor): ActionExecutor => {
    const precheck = inner.precheck?.bind(inner);

    const watched: ScopedActionExecutor = {
      async execute(request) {
        const result = await inner.execute(request);
        if (!seen.acknowledged && acknowledges(request, result, interaction.id)) {
          seen.acknowledged = true;
          // An earlier delivery made a duplicate's defer and may have answered it already.
          seen.publicDefer = result.status === 'executed' && defersPublicly(request);
        }
        if (followsUp(request, result, interaction.token)) seen.followedUp = true;
        return result;
      },

      ...(precheck ? { precheck } : {}),

      scoped(hints) {
        return isScopedActionExecutor(inner) ? wrap(inner.scoped(hints)) : watched;
      },
    };

    return watched;
  };

  return {
    executor: wrap(executor),
    acknowledged: () => seen.acknowledged,
    publicDeferOpen: () => seen.publicDefer && !seen.followedUp,
  };
}
