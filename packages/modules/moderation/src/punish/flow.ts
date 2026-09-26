import {
  encodeCustomId,
  errorStatus,
  type GuildState,
  hasWithAdmin,
  type InteractionMessage,
  type InteractionRef,
  interactionRef,
  MAX_MODAL_TITLE_LENGTH,
  type Modal,
  type ModalInteraction,
  type ModuleContext,
  openModal,
  type ProtonEvent,
  parseCustomId,
  permissionLabels,
  readComponentInteraction,
  readMemberPermissions,
  readModalInteraction,
} from '@proton/core';
import { ButtonStyle, ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { DRAFT_TTL_MS, newDraftId } from '../drafts.ts';
import {
  acknowledged,
  confirmPrompt,
  followUpTo,
  replyTo,
  respondTo,
  send,
  statusMessage,
  textMessage,
  updateTo,
  WORKING,
} from '../interactions/respond.ts';
import { isRefusal, MODULE_ID, readSpan } from '../perform.ts';
import { PUNISH_DURATION_MAX_MS, type PunishKind } from './config.ts';
import {
  CONFIRM_ELSEWHERE,
  DRAFTS_UNBOUND,
  deliver,
  EXPIRED,
  executePending,
  followChannel,
  MODERATION_OFF,
  NOT_YOURS,
  PENDING_PUNISHMENTS,
  type Pending,
  type PendingPunishment,
  type Presser,
  pendingIdOf,
  presserOf,
  proofSchema,
  punishActorOf,
  REPORT_ACCEPT_UNBOUND,
  readGuildState,
  staleAnswer,
  storedOf,
} from './pending.ts';
import {
  BAN_TOO_LONG,
  banDurationOf,
  canDeleteIn,
  DUPLICATE_MESSAGE,
  REASON_MAX,
  resolveReason,
} from './pipeline.ts';
import { KIND_COMMAND, KIND_PERMISSION, type ProofMessage } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const PICK_ACTION = 'ppick';
export const FLOW_MODAL_ACTION = 'pmod';

export const FLOW_FIELDS = {
  reason: 'reason',
  duration: 'duration',
  message: 'message',
  note: 'note',
  reporter: 'reporter',
} as const;

const PICKER_ORDER: readonly PunishKind[] = ['warn', 'timeout', 'kick', 'ban'];

const LABEL_MAX = 45;
const DURATION_INPUT_MAX = 32;
const NOTE_MAX = 1000;

export const PUNISH_TITLES: Readonly<Record<PunishKind, string>> = {
  warn: 'Warn',
  timeout: 'Time out',
  kick: 'Kick',
  ban: 'Ban',
};

const CHOICES: Readonly<Record<PendingPunishment, string>> = {
  warn: 'Warn',
  timeout: 'Time out',
  kick: 'Kick',
  ban: 'Ban',
  none: 'No punishment',
};

const BUTTONS_PER_ROW = 5;

export interface FlowStart {
  targetId: string;
  proof?: ProofMessage;
  origin: { type: 'message' } | { type: 'report'; reportId: string };
  prefillReason?: string;
  reporterNoteField?: boolean;
}

export interface FlowFacts {
  interaction: InteractionRef;
  applicationId: string | null;
  actorId: string;
  roleIds: string[] | null;
  permissions: bigint | null;
  channelId: string | null;
  idempotencyKey?: string;
}

export const flowDraftSchema = z.object({
  kind: z.literal('punish-flow'),
  guildId: z.string(),
  actorId: z.string(),
  channelId: z.string().nullable(),
  targetId: z.string(),
  targetName: z.string().nullable(),
  proof: proofSchema.nullable(),
  proofDeletable: z.boolean(),
  origin: z.discriminatedUnion('type', [
    z.object({ type: z.literal('message') }),
    z.object({ type: z.literal('report'), reportId: z.string() }),
  ]),
  prefillReason: z.string().nullable(),
  reporterNoteField: z.boolean(),
  choices: z.array(z.enum(PENDING_PUNISHMENTS)),
  createdAt: z.number(),
});

export type FlowDraft = z.infer<typeof flowDraftSchema>;

export function flowFactsOf(event: ProtonEvent): FlowFacts | null {
  const read =
    event.type === 'interaction.modal'
      ? readModalInteraction(event)
      : readComponentInteraction(event);
  if (!read) return null;

  return {
    interaction: interactionRef(read),
    applicationId: read.applicationId,
    actorId: read.userId,
    roleIds: read.roleIds,
    permissions: readMemberPermissions(event),
    channelId: read.channelId,
  };
}

interface Usable {
  kinds: PunishKind[];
  gated: string | null;
}

async function usableKinds(
  ctx: Ctx,
  deps: ModerationDeps,
  facts: FlowFacts,
  state: GuildState | null,
): Promise<Usable> {
  const owner = state?.ownerId === facts.actorId;
  const kinds: PunishKind[] = [];
  let gated: string | null = null;

  for (const kind of PICKER_ORDER) {
    if (!owner && !hasWithAdmin(facts.permissions ?? 0n, KIND_PERMISSION[kind])) continue;

    if (deps.commandGate) {
      try {
        const gate = await deps.commandGate(ctx.guildId, KIND_COMMAND[kind], facts.roleIds ?? []);
        if (!gate.allowed) {
          gated ??= gate.message;
          continue;
        }
      } catch (error) {
        ctx.logger.warn(
          `moderation could not read the command permissions for /${KIND_COMMAND[kind]}, so it ` +
            `left ${kind} out of the punishment picker: ${
              error instanceof Error ? error.message : String(error)
            }`,
          { guildId: ctx.guildId, moduleId: MODULE_ID },
        );
        continue;
      }
    }

    kinds.push(kind);
  }

  return { kinds, gated };
}

function noKindsMessage(usable: Usable): string {
  if (usable.gated) return usable.gated;

  const labels = [
    ...new Set(PICKER_ORDER.flatMap((kind) => permissionLabels(KIND_PERMISSION[kind]))),
  ];
  return (
    `You need ${labels.join(', ').replace(/, ([^,]*)$/, ' or $1')} in this server to punish ` +
    'members, so nothing was done.'
  );
}

async function nameOf(deps: ModerationDeps, userId: string): Promise<string | null> {
  try {
    return (await deps.users?.resolve(userId))?.username ?? null;
  } catch {
    return null;
  }
}

export function pickerMessage(
  draft: FlowDraft,
  draftId: string,
  notice?: string,
): InteractionMessage | null {
  const buttons: Record<string, unknown>[] = [];

  for (const choice of draft.choices) {
    const customId = encodeCustomId(MODULE_ID, PICK_ACTION, draftId, choice);
    if (!customId.ok) return null;

    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: CHOICES[choice],
      custom_id: customId.customId,
    });
  }

  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < buttons.length; at += BUTTONS_PER_ROW) {
    rows.push({
      type: ComponentType.ActionRow,
      components: buttons.slice(at, at + BUTTONS_PER_ROW),
    });
  }

  const who = `<@${draft.targetId}>`;
  const text =
    draft.origin.type === 'report'
      ? `Accepting report \`${draft.origin.reportId}\`. Choose what happens to ${who}.`
      : `Choose a punishment for ${who}.`;

  return textMessage(notice ? `${notice}\n\n${text}` : text, rows);
}

export async function startPunishFlow(
  ctx: Ctx,
  deps: ModerationDeps,
  facts: FlowFacts,
  start: FlowStart,
): Promise<void> {
  const to = respondTo(ctx.guildId, facts.actorId, facts.interaction, facts.idempotencyKey);
  const applicationId = facts.applicationId ?? deps.applicationId;
  const say = async (message: InteractionMessage) => {
    if (!applicationId) {
      ctx.logger.error(
        'moderation could not show the punishment picker: Proton has no application id to ' +
          'answer with, so the moderator was told nothing.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }
    await send(ctx, followUpTo({ ...to, applicationId }, message, 'picker'));
  };
  const refuse = (text: string) => say(statusMessage(errorStatus(text)));

  if (!ctx.config.enabled) return refuse(MODERATION_OFF);
  if (!deps.drafts) return refuse(DRAFTS_UNBOUND);
  if (start.origin.type === 'report' && !deps.reportAccept) return refuse(REPORT_ACCEPT_UNBOUND);

  const state = await readGuildState(deps, ctx.guildId);
  const usable = await usableKinds(ctx, deps, facts, state);
  if (usable.kinds.length === 0 && start.origin.type !== 'report') {
    return refuse(noKindsMessage(usable));
  }

  const proof = start.proof ?? null;
  const draft: FlowDraft = {
    kind: 'punish-flow',
    guildId: ctx.guildId,
    actorId: facts.actorId,
    channelId: facts.channelId,
    targetId: start.targetId,
    targetName: await nameOf(deps, start.targetId),
    proof,
    proofDeletable:
      proof !== null &&
      state !== null &&
      canDeleteIn(
        state,
        punishActorOf({
          id: facts.actorId,
          roleIds: facts.roleIds,
          permissions: facts.permissions,
        }),
        proof.channelId,
      ),
    origin: start.origin,
    prefillReason: start.prefillReason?.trim() || null,
    reporterNoteField: start.reporterNoteField === true,
    choices: start.origin.type === 'report' ? [...usable.kinds, 'none'] : usable.kinds,
    createdAt: deps.now?.() ?? Date.now(),
  };

  const draftId = newDraftId();
  const picker = pickerMessage(draft, draftId);
  if (!picker) return refuse("I couldn't build the punishment picker, so nothing was done.");

  await deps.drafts.put(ctx.guildId, draftId, draft, DRAFT_TTL_MS);
  await say(picker);
}

export async function openPunishFlow(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
  start: FlowStart,
): Promise<void> {
  const facts = flowFactsOf(event);
  if (!facts) {
    ctx.logger.warn('moderation could not read the interaction that asked for a punishment.', {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return;
  }

  await startPunishFlow(ctx, deps, facts, start);
}

function labelled(
  label: string,
  description: string | null,
  component: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: ComponentType.Label,
    label: label.slice(0, LABEL_MAX),
    ...(description ? { description: description.slice(0, 100) } : {}),
    component,
  };
}

function textInput(
  customId: string,
  style: TextInputStyle,
  options: { required: boolean; max: number; value?: string | null },
): Record<string, unknown> {
  const value = options.value?.slice(0, options.max) ?? '';

  return {
    type: ComponentType.TextInput,
    custom_id: customId,
    style,
    required: options.required,
    max_length: options.max,
    ...(value ? { value } : {}),
  };
}

export function reasonInput(value: string | null, required: boolean): Record<string, unknown> {
  return labelled(
    'Reason',
    'Shown to the member and in Discord’s audit log.',
    textInput(FLOW_FIELDS.reason, TextInputStyle.Paragraph, { required, max: REASON_MAX, value }),
  );
}

export function durationInput(
  kind: 'timeout' | 'ban',
  value: string | null,
): Record<string, unknown> {
  return labelled(
    'Duration',
    kind === 'ban'
      ? 'For example 12h or 7d. Leave empty or type permanent to ban for good.'
      : 'For example 30m, 2h or 7d.',
    textInput(FLOW_FIELDS.duration, TextInputStyle.Short, {
      required: false,
      max: DURATION_INPUT_MAX,
      value,
    }),
  );
}

export function durationPrefill(config: ModerationConfig, kind: 'timeout' | 'ban'): string | null {
  return kind === 'timeout'
    ? config.punish.types.timeout.defaultDuration
    : config.punish.types.ban.defaultDuration;
}

export function modalTitle(verb: string, name: string | null): string {
  const title = `${verb} ${name ? `@${name}` : 'member'}`;
  return title.length <= MAX_MODAL_TITLE_LENGTH
    ? title
    : `${title.slice(0, MAX_MODAL_TITLE_LENGTH - 1)}…`;
}

export function flowModal(
  config: ModerationConfig,
  draft: FlowDraft,
  draftId: string,
  choice: PendingPunishment,
): Modal | null {
  const customId = encodeCustomId(MODULE_ID, FLOW_MODAL_ACTION, draftId, choice);
  if (!customId.ok) return null;

  const components: Record<string, unknown>[] = [];

  if (choice !== 'none') {
    const settings = config.punish.types[choice];
    components.push(
      reasonInput(draft.prefillReason ?? (settings.defaultReason || null), settings.forceReason),
    );

    if (choice === 'timeout' || choice === 'ban') {
      components.push(durationInput(choice, durationPrefill(config, choice)));
    }
  }

  if (draft.proof && draft.proofDeletable) {
    const remove = choice !== 'none' && config.punish.types[choice].deleteProof;
    components.push(
      labelled(draft.origin.type === 'report' ? 'Reported message' : 'The message', null, {
        type: ComponentType.StringSelect,
        custom_id: FLOW_FIELDS.message,
        required: true,
        min_values: 1,
        max_values: 1,
        options: [
          { label: 'Keep the message', value: 'keep', ...(remove ? {} : { default: true }) },
          { label: 'Delete the message', value: 'delete', ...(remove ? { default: true } : {}) },
        ],
      }),
    );
  }

  if (draft.origin.type === 'report') {
    components.push(
      labelled(
        'Internal note',
        'Staff only. Never shown to the reporter.',
        textInput(FLOW_FIELDS.note, TextInputStyle.Paragraph, { required: false, max: NOTE_MAX }),
      ),
    );

    if (draft.reporterNoteField) {
      components.push(
        labelled(
          'Reporter note',
          'Sent to the member who filed the report, with the outcome.',
          textInput(FLOW_FIELDS.reporter, TextInputStyle.Paragraph, {
            required: false,
            max: NOTE_MAX,
          }),
        ),
      );
    }
  }

  return {
    customId: customId.customId,
    title:
      choice === 'none'
        ? 'Accept without punishment'
        : modalTitle(PUNISH_TITLES[choice], draft.targetName),
    components: components.slice(0, 5),
  };
}

export async function handlePick(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID || parsed.action !== PICK_ACTION) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  const refuse = async (text: string) => {
    await send(ctx, replyTo(to, statusMessage(errorStatus(text))));
  };

  if (!ctx.config.enabled) return refuse(MODERATION_OFF);

  const drafts = deps.drafts;
  if (!drafts) return refuse(DRAFTS_UNBOUND);

  const draftId = pendingIdOf(parsed.args[0]);
  const draft = draftId ? await drafts.get(ctx.guildId, draftId, flowDraftSchema) : null;

  if (!draftId || !draft || draft.guildId !== ctx.guildId) {
    await send(ctx, updateTo(to, statusMessage(errorStatus(EXPIRED))));
    return;
  }
  if (draft.actorId !== press.userId) return refuse(NOT_YOURS);

  // Pickers posted before the buttons carried the choice in the select's value instead.
  const picked = parsed.args[1] ?? press.values[0];
  const choice = draft.choices.find((candidate) => candidate === picked);
  if (!choice) return refuse('That action isn’t available here. Pick another one.');

  const modal = flowModal(ctx.config, draft, draftId, choice);
  if (!modal) return refuse("I couldn't build that form, so nothing was done.");

  await send(ctx, openModal(to, modal));
}

interface FlowAnswers {
  reason: string | null;
  duration: string | null | undefined;
  deleteProof: boolean;
  note: string | null;
  reporterNote: string | null;
}

function readAnswers(
  config: ModerationConfig,
  modal: ModalInteraction,
  draft: FlowDraft,
  choice: PendingPunishment,
): FlowAnswers {
  const text = (id: string) => (modal.fields[id] ?? '').trim();
  const duration = text(FLOW_FIELDS.duration);
  const picked = modal.values[FLOW_FIELDS.message]?.[0];

  return {
    reason: choice === 'none' ? null : text(FLOW_FIELDS.reason) || null,
    duration:
      choice === 'ban'
        ? (banDurationOf(duration) ?? null)
        : choice === 'timeout'
          ? duration || undefined
          : undefined,
    deleteProof:
      draft.proof !== null &&
      draft.proofDeletable &&
      (picked === undefined
        ? choice !== 'none' && config.punish.types[choice].deleteProof
        : picked === 'delete'),
    note: draft.origin.type === 'report' ? text(FLOW_FIELDS.note) || null : null,
    reporterNote: draft.reporterNoteField ? text(FLOW_FIELDS.reporter) || null : null,
  };
}

function answerProblem(
  config: ModerationConfig,
  choice: PendingPunishment,
  answers: FlowAnswers,
  presser: Presser,
): string | null {
  if (choice === 'none') return null;

  const reason = resolveReason(
    config.punish,
    choice,
    punishActorOf(presser),
    answers.reason ?? undefined,
  );
  if ('refusal' in reason) return reason.refusal;

  if (answers.duration) {
    const span = readSpan(answers.duration);
    if (isRefusal(span)) return span.refusal;
    if (span.ms <= 0) return `'${answers.duration}' ends immediately. Pick a longer duration.`;
    if (choice === 'ban' && span.ms > PUNISH_DURATION_MAX_MS) return BAN_TOO_LONG;
  }

  return null;
}

export function needsReview(config: ModerationConfig, choice: PendingPunishment): boolean {
  if (choice === 'none') return false;
  return choice === 'ban' || choice === 'kick' || config.punish.types[choice].alwaysReview;
}

function reviewText(config: ModerationConfig, pending: Pending, kind: PunishKind): string {
  const lines = [`${PUNISH_TITLES[kind]} <@${pending.targetId}>?`];

  if (pending.reason) lines.push(`Reason: ${pending.reason}`);

  if (kind === 'timeout') {
    lines.push(`Duration: ${pending.duration ?? config.punish.types.timeout.defaultDuration}`);
  }
  if (kind === 'ban') lines.push(`Duration: ${pending.duration ?? 'permanent'}`);

  if (pending.deleteProof) lines.push('The message will be deleted.');

  return lines.join('\n');
}

function pendingFrom(
  draft: FlowDraft,
  choice: PendingPunishment,
  answers: FlowAnswers,
  now: number,
): Pending {
  return {
    kind: 'punish',
    guildId: draft.guildId,
    actorId: draft.actorId,
    channelId: draft.channelId,
    punishment: choice,
    targetId: draft.targetId,
    reason: answers.reason,
    ...(answers.duration !== undefined ? { duration: answers.duration } : {}),
    proof: draft.proof,
    deleteProof: answers.deleteProof,
    origin: draft.origin,
    confirmedRecentCase: false,
    note: answers.note,
    reporterNote: answers.reporterNote,
    publicResult: false,
    createdAt: now,
  };
}

export async function handleFlowModal(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const modal = readModalInteraction(event);
  const parsed = parseCustomId(modal?.customId);
  if (!modal || parsed?.moduleId !== MODULE_ID || parsed.action !== FLOW_MODAL_ACTION) return;

  const to = respondTo(ctx.guildId, modal.userId, interactionRef(modal));
  const refuse = async (text: string) => {
    await send(ctx, replyTo(to, statusMessage(errorStatus(text))));
  };

  if (!ctx.config.enabled) return refuse(MODERATION_OFF);

  const drafts = deps.drafts;
  if (!drafts) return refuse(DRAFTS_UNBOUND);

  const draftId = pendingIdOf(parsed.args[0]);
  const draft = draftId ? await drafts.get(ctx.guildId, draftId, flowDraftSchema) : null;

  if (!draftId || !draft || draft.guildId !== ctx.guildId) {
    await send(ctx, updateTo(to, await staleAnswer(drafts, ctx.guildId, draftId)));
    return;
  }
  if (draft.actorId !== modal.userId) return refuse(NOT_YOURS);

  const choice = draft.choices.find((candidate) => candidate === parsed.args[1]);
  if (!choice) return refuse('That action isn’t available here. Pick another one.');

  const presser = presserOf(event, modal);
  const answers = readAnswers(ctx.config, modal, draft, choice);
  const problem = answerProblem(ctx.config, choice, answers, presser);
  if (problem) {
    const picker = pickerMessage(draft, draftId, problem);
    await send(
      ctx,
      picker ? updateTo(to, picker) : replyTo(to, statusMessage(errorStatus(problem))),
    );
    return;
  }

  const pending = pendingFrom(draft, choice, answers, deps.now?.() ?? Date.now());

  if (choice !== 'none' && needsReview(ctx.config, choice)) {
    const taken = await drafts.take(ctx.guildId, draftId, flowDraftSchema);
    if (!taken) {
      const message = await staleAnswer(drafts, ctx.guildId, draftId, DUPLICATE_MESSAGE);
      await send(ctx, updateTo(to, message));
      return;
    }

    const pendingId = newDraftId();
    const prompt = confirmPrompt(reviewText(ctx.config, pending, choice), pendingId, {
      confirmLabel: PUNISH_TITLES[choice],
      danger: choice === 'ban' || choice === 'kick',
    });
    if (!prompt) return refuse("I couldn't build the confirmation, so nothing was done.");

    await drafts.put(ctx.guildId, pendingId, pending, DRAFT_TTL_MS);
    await drafts.putOutcome(ctx.guildId, draftId, { tone: 'neutral', text: CONFIRM_ELSEWHERE });
    await send(ctx, updateTo(to, prompt));
    return;
  }

  if (!acknowledged(await send(ctx, updateTo(to, textMessage(WORKING))))) return;

  const channel = followChannel(ctx, to, modal.applicationId ?? deps.applicationId);
  const taken = await drafts.take(ctx.guildId, draftId, flowDraftSchema);
  if (!taken) {
    const message = await staleAnswer(drafts, ctx.guildId, draftId, DUPLICATE_MESSAGE);
    await channel.say(message, 'result', true);
    return;
  }

  const settled = await executePending(ctx, deps, pending, {
    id: draftId,
    presser,
    token: event.id,
  });

  await drafts.putOutcome(ctx.guildId, draftId, storedOf(settled));
  await deliver(ctx, deps, channel, settled, { resultEphemeral: true, actorId: modal.userId });
}
