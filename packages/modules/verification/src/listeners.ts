import type { EventListener, EventType } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { handleJoin } from './gate.ts';
import { handleComponent, handleModal } from './interactions.ts';
import { handleWebPassed, reconcilePanel } from './service.ts';

export const VERIFICATION_EVENT_TYPES: EventType[] = ['member.joined'];

export const COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

export const MODAL_EVENT_TYPES: EventType[] = ['interaction.modal'];

export const SERVICE_EVENT_TYPES: EventType[] = [
  'proton.config_changed',
  'proton.panel_requested',
  'verification.web_passed',
];

export function createJoinGateListener(deps: VerificationDeps): EventListener<VerificationConfig> {
  return {
    types: VERIFICATION_EVENT_TYPES,
    async handler(event, ctx) {
      await handleJoin(event, ctx, deps);
    },
  };
}

export function createComponentListener(deps: VerificationDeps): EventListener<VerificationConfig> {
  return {
    types: COMPONENT_EVENT_TYPES,
    async handler(event, ctx) {
      await handleComponent(event, ctx, deps);
    },
  };
}

export function createModalListener(deps: VerificationDeps): EventListener<VerificationConfig> {
  return {
    types: MODAL_EVENT_TYPES,
    async handler(event, ctx) {
      await handleModal(event, ctx, deps);
    },
  };
}

export function createServiceListener(deps: VerificationDeps): EventListener<VerificationConfig> {
  return {
    types: SERVICE_EVENT_TYPES,
    async handler(event, ctx) {
      // The dashboard's "post it" button and a config save both end in the same reconcile: it
      // posts the panel, or edits the one already there, or re-posts one somebody deleted. The
      // button exists for that last case, which a save alone only fixes by accident.
      if (event.type === 'proton.config_changed' || event.type === 'proton.panel_requested') {
        await reconcilePanel(event, ctx, deps);
        return;
      }

      await handleWebPassed(event, ctx, deps);
    },
  };
}
