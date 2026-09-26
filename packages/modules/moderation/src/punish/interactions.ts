import type { ModuleContext, ProtonEvent } from '@proton/core';
import { handleReview, REVIEW_ACTION } from '../commands/member.ts';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { CANCEL_ACTION, CONFIRM_ACTION } from '../interactions/respond.ts';
import { FLOW_MODAL_ACTION, handleFlowModal, handlePick, PICK_ACTION } from './flow.ts';
import { handleCancel, handleConfirm } from './pending.ts';

export type PunishInteractionHandler = (
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
) => Promise<void>;

export type PunishAction = 'ppick' | 'pmod' | 'pgo' | 'pstop' | 'prv';

export const PUNISH_ACTIONS: Readonly<Record<PunishAction, PunishInteractionHandler>> = {
  [PICK_ACTION]: handlePick,
  [FLOW_MODAL_ACTION]: handleFlowModal,
  [CONFIRM_ACTION]: handleConfirm,
  [CANCEL_ACTION]: handleCancel,
  [REVIEW_ACTION]: handleReview,
};
