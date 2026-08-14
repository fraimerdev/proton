import { z } from 'zod';

/**
 * Gate 0 implements exactly one kind. The union widens per phase as each kind
 * gains a real implementation and a real test — an unimplemented member here
 * would just be a dead branch in the executor.
 */
export const ACTION_KINDS = ['send', 'interaction_reply'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Verbatim from PLAN.md §4-P3. */
export interface ActionRequest {
  guildId: string;
  moduleId: string;
  kind: ActionKind;
  targetId?: string;
  actorId: string;
  reason?: string;
  payload?: unknown;
  expiresAt?: Date;
  dryRun: boolean;
  idempotencyKey: string;
}

export type ActionStatus =
  | 'executed'
  | 'dry_run'
  | 'skipped_duplicate'
  | 'failed_precheck'
  | 'failed_api';

export interface ActionFailure {
  code: string;
  /** Surfaced verbatim to the invoker (PLAN.md §1) — must name what and where. */
  humanReason: string;
}

export interface ActionResult {
  caseId?: string;
  status: ActionStatus;
  failure?: ActionFailure;
}

export interface ActionExecutor {
  execute(request: ActionRequest): Promise<ActionResult>;
}

export const actionRequestSchema = z.object({
  guildId: z.string().min(1),
  moduleId: z.string().min(1),
  kind: z.enum(ACTION_KINDS),
  targetId: z.string().min(1).optional(),
  actorId: z.string().min(1),
  reason: z.string().optional(),
  payload: z.unknown().optional(),
  // Gate 0 has no reversal scheduler. Accepting this silently would mean a temp
  // action that never reverses, so it is rejected rather than ignored.
  expiresAt: z.date().optional(),
  dryRun: z.boolean(),
  idempotencyKey: z.string().min(1),
});

/** Payload shape for `kind: 'send'`. */
export const sendPayloadSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(2000),
});

export type SendPayload = z.infer<typeof sendPayloadSchema>;

/**
 * Payload for `kind: 'interaction_reply'`.
 *
 * A separate kind rather than reusing `send`, because acknowledging an
 * interaction hits a different endpoint with different rules: the token is valid
 * for 15 minutes, the first response must land within 3 seconds (I9), and
 * posting a channel message instead would leave Discord showing "the application
 * did not respond".
 */
export const interactionReplyPayloadSchema = z.object({
  interactionId: z.string().min(1),
  interactionToken: z.string().min(1),
  content: z.string().min(1).max(2000),
  ephemeral: z.boolean().default(false),
});

export type InteractionReplyPayload = z.infer<typeof interactionReplyPayloadSchema>;

/** Discord InteractionCallbackType.ChannelMessageWithSource. */
export const INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;
/** MessageFlags.Ephemeral (1<<6). */
export const MESSAGE_FLAG_EPHEMERAL = 64;
