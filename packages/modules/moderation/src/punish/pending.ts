import {
  errorStatus,
  type FollowUpTo,
  type GuildState,
  hasWithAdmin,
  type InteractionMessage,
  interactionRef,
  labelOf,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  permissionLabels,
  type RespondTo,
  readComponentInteraction,
  readMemberPermissions,
  successStatus,
} from '@proton/core';
import { describeError } from '@proton/db';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps, ReportAcceptResult } from '../deps.ts';
import { DRAFT_ID_PATTERN, DRAFT_TTL_MS, type DraftStore, newDraftId } from '../drafts.ts';
import {
  acknowledged,
  CANCEL_ACTION,
  CANCELLED,
  CONFIRM_ACTION,
  confirmPrompt,
  followUpTo,
  replyTo,
  respondTo,
  send,
  statusMessage,
  textMessage,
  updateTo,
  WORKING,
  withCase,
} from '../interactions/respond.ts';
import { MODULE_ID } from '../perform.ts';
import { PUNISH_KINDS, type PunishKind } from './config.ts';
import { DUPLICATE_MESSAGE, punish } from './pipeline.ts';
import {
  DIRECTION_VERB,
  KIND_COMMAND,
  KIND_PERMISSION,
  type PunishActor,
  type PunishOutcome,
} from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const MODERATION_OFF = 'Moderation is off in this server, so nothing was done.';

export const EXPIRED =
  'This expired, so nothing was done. Start again from the report, the message or the command.';

export const NOT_YOURS = 'Only the moderator who started this can use it.';

export const DRAFTS_UNBOUND =
  "I can't keep track of this right now, so nothing was done. This is a problem on my end, not " +
  'a setting in this server.';

export const REPORT_ACCEPT_UNBOUND =
  "I can't accept reports right now, so nothing was done. This is a problem on my end, not a " +
  'setting in this server.';

export const CONFIRM_ELSEWHERE = 'Confirm or cancel in the newer message.';

const NO_APPLICATION =
  'moderation could not follow up an interaction: Proton has no application id to answer with, ' +
  'so the moderator was told nothing.';

const resolvedAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number(),
  url: z.string(),
  proxyUrl: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  ephemeral: z.boolean(),
  expiresAt: z.number().nullable(),
});

export const proofSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  authorId: z.string(),
  content: z.string(),
  createdAt: z.number().nullable(),
  attachments: z.array(resolvedAttachmentSchema),
  url: z.string(),
});

export const PENDING_PUNISHMENTS = ['none', ...PUNISH_KINDS] as const;
export type PendingPunishment = (typeof PENDING_PUNISHMENTS)[number];

export const pendingOriginSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command') }),
  z.object({ type: z.literal('message') }),
  z.object({ type: z.literal('report'), reportId: z.string() }),
]);

export const pendingSchema = z.object({
  kind: z.literal('punish'),
  guildId: z.string(),
  actorId: z.string(),
  channelId: z.string().nullable(),
  punishment: z.enum(PENDING_PUNISHMENTS),
  targetId: z.string(),
  reason: z.string().nullable(),
  duration: z.string().nullable().optional(),
  deleteMessageDays: z.number().int().min(0).max(7).optional(),
  proof: proofSchema.nullable(),
  deleteProof: z.boolean().optional(),
  origin: pendingOriginSchema,
  confirmedRecentCase: z.boolean(),
  note: z.string().nullable(),
  reporterNote: z.string().nullable(),
  publicResult: z.boolean(),
  invokerHadPermission: z.boolean().optional(),
  createdAt: z.number(),
});

export type Pending = z.infer<typeof pendingSchema>;

export const pendingOutcomeSchema = z.object({
  tone: z.enum(['success', 'error', 'neutral']),
  text: z.string(),
});

export type PendingOutcome = z.infer<typeof pendingOutcomeSchema>;

export type Settled =
  | { tone: 'success' | 'error'; text: string }
  | { tone: 'confirm'; text: string; retry: Pending };

export interface Presser {
  id: string;
  roleIds: string[] | null;
  permissions: bigint | null;
}

export interface Channel {
  publicLoading: boolean;
  say(message: InteractionMessage, suffix: string, ephemeral: boolean): Promise<void>;
}

export function pendingRoot(guildId: string, id: string): string {
  return `moderation:pending:${guildId}:${id}`;
}

export function pendingIdOf(raw: string | undefined): string | null {
  return raw && DRAFT_ID_PATTERN.test(raw) ? raw : null;
}

export function punishActorOf(presser: Presser): PunishActor {
  return {
    id: presser.id,
    roleIds: presser.roleIds,
    permissions: presser.permissions,
    kind: 'member',
  };
}

export async function readGuildState(
  deps: ModerationDeps,
  guildId: string,
): Promise<GuildState | null> {
  try {
    return (await deps.guildState?.get(guildId)) ?? null;
  } catch {
    return null;
  }
}

export function followChannel(
  ctx: Ctx,
  to: RespondTo,
  applicationId: string | null | undefined,
  publicLoading = false,
): Channel {
  return {
    publicLoading,
    async say(message, suffix, ephemeral) {
      if (!applicationId) {
        ctx.logger.error(NO_APPLICATION, { guildId: ctx.guildId, moduleId: MODULE_ID });
        return;
      }

      const target: FollowUpTo = { ...to, applicationId };
      await send(ctx, followUpTo(target, message, suffix, ephemeral));
    },
  };
}

export function replyChannel(ctx: Ctx, to: RespondTo): Channel {
  let answered = false;

  return {
    publicLoading: false,
    async say(message, _suffix, ephemeral) {
      if (answered) {
        ctx.logger.error(NO_APPLICATION, { guildId: ctx.guildId, moduleId: MODULE_ID });
        return;
      }

      answered = true;
      await send(ctx, replyTo(to, message, ephemeral));
    },
  };
}

export function outcomeMessage(outcome: PendingOutcome): InteractionMessage {
  switch (outcome.tone) {
    case 'success':
      return statusMessage(successStatus(outcome.text));
    case 'error':
      return statusMessage(errorStatus(outcome.text));
    case 'neutral':
      return textMessage(outcome.text);
  }
}

export function storedOf(settled: Settled): PendingOutcome {
  return settled.tone === 'confirm'
    ? { tone: 'neutral', text: CONFIRM_ELSEWHERE }
    : { tone: settled.tone, text: settled.text };
}

export function settledFromPunish(outcome: PunishOutcome, pending: Pending): Settled {
  switch (outcome.status) {
    case 'executed':
      return { tone: 'success', text: withCase(outcome.summary, outcome.caseId) };
    case 'needs_confirmation':
      return {
        tone: 'confirm',
        text: outcome.message,
        retry: { ...pending, confirmedRecentCase: true },
      };
    default:
      return { tone: 'error', text: outcome.message };
  }
}

function settledFromReport(result: ReportAcceptResult, pending: Pending): Settled {
  if (result.ok) return { tone: 'success', text: withCase(result.message, result.caseId) };

  if (result.needsConfirmation === 'recent_case') {
    return {
      tone: 'confirm',
      text: result.message,
      retry: { ...pending, confirmedRecentCase: true },
    };
  }

  return { tone: 'error', text: result.message };
}

async function commandRecheck(
  ctx: Ctx,
  deps: ModerationDeps,
  kind: PunishKind,
  pending: Pending,
  presser: Presser,
): Promise<string | null> {
  const command = KIND_COMMAND[kind];

  if (deps.commandGate) {
    try {
      const gate = await deps.commandGate(ctx.guildId, command, presser.roleIds ?? []);
      if (!gate.allowed) return gate.message;
    } catch (error) {
      ctx.logger.warn(
        `moderation could not read the command permissions for /${command}: ${describeError(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return (
        `I couldn't check whether you can still use ${labelOf(ctx, command)} in this server, so ` +
        'nothing was done. Try again in a moment.'
      );
    }
  }

  const required = KIND_PERMISSION[kind];
  if (!pending.invokerHadPermission || hasWithAdmin(presser.permissions ?? 0n, required)) {
    return null;
  }
  if ((await readGuildState(deps, ctx.guildId))?.ownerId === presser.id) return null;

  return (
    `You need the ${permissionLabels(required).join(', ')} permission in this server to ` +
    `${DIRECTION_VERB[kind]} members, so nothing was done.`
  );
}

export async function executePending(
  ctx: Ctx,
  deps: ModerationDeps,
  pending: Pending,
  input: { id: string; presser: Presser; token: string },
): Promise<Settled> {
  const { presser } = input;
  const origin = pending.origin;

  if (origin.type === 'report') {
    if (!deps.reportAccept) return { tone: 'error', text: REPORT_ACCEPT_UNBOUND };

    const state = await readGuildState(deps, ctx.guildId);
    const result = await deps.reportAccept(ctx, {
      reportId: origin.reportId,
      actor: {
        id: presser.id,
        roleIds: presser.roleIds,
        permissions: presser.permissions ?? 0n,
        source: 'discord',
        ...(state?.ownerId === presser.id ? { owner: true } : {}),
      },
      punishment: pending.punishment,
      ...(pending.reason !== null ? { reason: pending.reason } : {}),
      ...(pending.duration !== undefined ? { duration: pending.duration } : {}),
      deleteMessage: pending.deleteProof === true,
      ...(pending.note ? { note: pending.note } : {}),
      ...(pending.reporterNote ? { reporterNote: pending.reporterNote } : {}),
      ...(pending.confirmedRecentCase ? { confirmRecentCase: true } : {}),
      token: input.token,
    });

    return settledFromReport(result, pending);
  }

  if (pending.punishment === 'none') {
    return { tone: 'error', text: "There's nothing to carry out here, so nothing was done." };
  }

  if (origin.type === 'command') {
    const refusal = await commandRecheck(ctx, deps, pending.punishment, pending, presser);
    if (refusal) return { tone: 'error', text: refusal };
  }

  const outcome = await punish(ctx, deps, {
    guildId: ctx.guildId,
    kind: pending.punishment,
    targetId: pending.targetId,
    actor: punishActorOf(presser),
    ...(pending.reason !== null ? { reason: pending.reason } : {}),
    ...(pending.duration !== undefined ? { duration: pending.duration } : {}),
    ...(pending.deleteMessageDays !== undefined
      ? { deleteMessageDays: pending.deleteMessageDays }
      : {}),
    ...(pending.proof ? { proof: pending.proof } : {}),
    ...(pending.deleteProof !== undefined ? { deleteProof: pending.deleteProof } : {}),
    origin,
    confirmedRecentCase: pending.confirmedRecentCase,
    ...(pending.channelId ? { channelId: pending.channelId } : {}),
    idempotencyRoot: pendingRoot(ctx.guildId, input.id),
  });

  return settledFromPunish(outcome, pending);
}

export async function deliver(
  ctx: Ctx,
  deps: ModerationDeps,
  channel: Channel,
  settled: Settled,
  options: { resultEphemeral: boolean; actorId: string },
): Promise<void> {
  if (settled.tone !== 'confirm') {
    const body =
      settled.tone === 'success' ? successStatus(settled.text) : errorStatus(settled.text);
    await channel.say(statusMessage(body), 'result', options.resultEphemeral);
    return;
  }

  const refuse = (text: string) =>
    channel.say(statusMessage(errorStatus(text)), 'result', options.resultEphemeral);

  if (!deps.drafts) return refuse(`${settled.text}\n\n${DRAFTS_UNBOUND}`);

  const pendingId = newDraftId();
  const prompt = confirmPrompt(settled.text, pendingId);
  if (!prompt) return refuse("I couldn't build the confirmation, so nothing was done.");

  await deps.drafts.put(ctx.guildId, pendingId, settled.retry, DRAFT_TTL_MS);

  if (channel.publicLoading) {
    await channel.say(
      textMessage(`Waiting for <@${options.actorId}> to confirm…`),
      'result',
      false,
    );
  }

  await channel.say(prompt, 'confirm', true);
}

async function kept(
  drafts: DraftStore,
  guildId: string,
  id: string | null,
): Promise<PendingOutcome | null> {
  return id ? drafts.getOutcome(guildId, id, pendingOutcomeSchema) : null;
}

export async function staleAnswer(
  drafts: DraftStore,
  guildId: string,
  id: string | null,
  fallback: string = EXPIRED,
): Promise<InteractionMessage> {
  const outcome = await kept(drafts, guildId, id);
  return outcome ? outcomeMessage(outcome) : statusMessage(errorStatus(fallback));
}

export function presserOf(
  event: ProtonEvent,
  facts: { userId: string; roleIds: string[] | null },
): Presser {
  return { id: facts.userId, roleIds: facts.roleIds, permissions: readMemberPermissions(event) };
}

export async function handleConfirm(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID || parsed.action !== CONFIRM_ACTION) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  const refuse = async (text: string) => {
    await send(ctx, replyTo(to, statusMessage(errorStatus(text))));
  };

  if (!ctx.config.enabled) return refuse(MODERATION_OFF);

  const drafts = deps.drafts;
  if (!drafts) return refuse(DRAFTS_UNBOUND);

  const id = pendingIdOf(parsed.args[0]);
  const pending = id ? await drafts.get(ctx.guildId, id, pendingSchema) : null;

  if (!id || !pending || pending.guildId !== ctx.guildId) {
    await send(ctx, updateTo(to, await staleAnswer(drafts, ctx.guildId, id)));
    return;
  }
  if (pending.actorId !== press.userId) return refuse(NOT_YOURS);

  if (!acknowledged(await send(ctx, updateTo(to, textMessage(WORKING))))) return;

  const channel = followChannel(ctx, to, press.applicationId ?? deps.applicationId);
  const resultEphemeral = !pending.publicResult;

  const taken = await drafts.take(ctx.guildId, id, pendingSchema);
  if (!taken) {
    const message = await staleAnswer(drafts, ctx.guildId, id, DUPLICATE_MESSAGE);
    await channel.say(message, 'result', resultEphemeral);
    return;
  }

  const settled = await executePending(ctx, deps, taken, {
    id,
    presser: presserOf(event, press),
    token: event.id,
  });

  await drafts.putOutcome(ctx.guildId, id, storedOf(settled));
  await deliver(ctx, deps, channel, settled, { resultEphemeral, actorId: press.userId });
}

export async function handleCancel(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID || parsed.action !== CANCEL_ACTION) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  const refuse = async (text: string) => {
    await send(ctx, replyTo(to, statusMessage(errorStatus(text))));
  };

  if (!ctx.config.enabled) return refuse(MODERATION_OFF);

  const drafts = deps.drafts;
  if (!drafts) return refuse(DRAFTS_UNBOUND);

  const id = pendingIdOf(parsed.args[0]);
  const pending = id ? await drafts.get(ctx.guildId, id, pendingSchema) : null;

  if (!id || !pending || pending.guildId !== ctx.guildId) {
    await send(ctx, updateTo(to, await staleAnswer(drafts, ctx.guildId, id)));
    return;
  }
  if (pending.actorId !== press.userId) return refuse(NOT_YOURS);

  const taken = await drafts.take(ctx.guildId, id, pendingSchema);
  if (!taken) {
    await send(ctx, updateTo(to, await staleAnswer(drafts, ctx.guildId, id, DUPLICATE_MESSAGE)));
    return;
  }

  await drafts.putOutcome(ctx.guildId, id, { tone: 'neutral', text: CANCELLED });
  await send(ctx, updateTo(to, textMessage(CANCELLED)));
}
