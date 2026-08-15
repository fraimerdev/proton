import type { EventListener, EventType } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { handleJoin } from './gate.ts';

/**
 * One event, and only one.
 *
 * `member.updated` is deliberately absent. Watching it would let the module
 * re-apply the unverified role to anyone who lost it — which sounds like
 * enforcement and is actually a loop: Proton's own removal on `/verify` arrives
 * back as a `member.updated`, and re-applying there would un-verify every member
 * the instant they verified.
 */
export const VERIFICATION_EVENT_TYPES: EventType[] = ['member.joined'];

export function createJoinGateListener(deps: VerificationDeps): EventListener<VerificationConfig> {
  return {
    types: VERIFICATION_EVENT_TYPES,
    async handler(event, ctx) {
      await handleJoin(event, ctx, deps);
    },
  };
}
