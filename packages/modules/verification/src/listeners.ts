import type { EventListener, EventType } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { handleJoin } from './gate.ts';

export const VERIFICATION_EVENT_TYPES: EventType[] = ['member.joined'];

export function createJoinGateListener(deps: VerificationDeps): EventListener<VerificationConfig> {
  return {
    types: VERIFICATION_EVENT_TYPES,
    async handler(event, ctx) {
      await handleJoin(event, ctx, deps);
    },
  };
}
