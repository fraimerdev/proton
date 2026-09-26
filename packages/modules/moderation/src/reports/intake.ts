import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  computeBasePermissions,
  deferEphemeral,
  encodeCustomId,
  errorStatus,
  followUp,
  type GuildState,
  interactionRef,
  labelOf,
  type Modal,
  type ModuleContext,
  openModal,
  type ProtonEvent,
  parseCustomId,
  REPORT_METHODS,
  type RespondTo,
  readComponentInteraction,
  readMemberPermissions,
  readModalInteraction,
  replyEphemeral,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { describeError } from '@proton/db';
import { ButtonStyle, ComponentType, InteractionType, TextInputStyle } from 'discord-api-types/v10';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { MemberLookup, ModerationDeps } from '../deps.ts';
import { DRAFT_ID_PATTERN, DRAFT_TTL_MS, newDraftId, REACTION_DRAFT_TTL_MS } from '../drafts.ts';
import { MODULE_ID } from '../perform.ts';
import { type IntakeCheck, validateReporter, validateTarget } from './authorize.ts';
import { COMMAND_OFF_HINT, METHOD_OFF_HINT, type ReportsConfig } from './config.ts';
import { attachmentMeta, captureLinks, clipStored, readLinkLines } from './evidence.ts';
import type { ReportSource } from './store.ts';
import { REPORT_STORE_UNBOUND, type SubmitOutcome, submitReport } from './submit.ts';
import {
  attachmentMetaSchema,
  type MessageEvidence,
  messageEvidenceSchema,
  REPORT_COMMAND,
  type ReportEvidence,
  type ReportMethod,
} from './types.ts';

export const REPORT_SUBMIT_ACTION = 'rsub';
export const REPORT_SUBMIT_DIRECT_ACTION = 'rsubd';
export const REPORT_FINISH_ACTION = 'rfin';
export const REPORT_RETRY_ACTION = 'rretry';

export const INTAKE_FIELDS = {
  reason: 'reason',
  custom: 'custom',
  comment: 'comment',
  files: 'files',
  links: 'links',
} as const;

export const MODAL_TITLE_MAX = 45;
const LABEL_MAX = 45;
const LINKS_INPUT_MAX = 700;
const SELECT_OPTIONS_MAX = 25;

export const MODERATION_OFF = 'Moderation is off in this server, so nothing was done.';
export const REPORTS_OFF = 'User reports are off in this server, so nothing was filed.';
export const DRAFT_EXPIRED =
  'This report form expired, so nothing was filed. Start the report again.';
export const DRAFT_NOT_YOURS = 'Only the member who started this report can finish it.';
export const DRAFTS_UNBOUND =
  'I can’t take reports right now, so nothing was filed. Let the server’s staff know.';
export const SAVE_FAILED =
  'I couldn’t save your report, so nothing was filed. Try again in a moment.';

const sourceSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  authorId: z.string().nullable(),
});

const answersSchema = z.object({
  reasonId: z.string().nullable(),
  custom: z.string(),
  comment: z.string(),
  links: z.string(),
});

export const intakeDraftSchema = z.object({
  kind: z.literal('report'),
  guildId: z.string(),
  actorId: z.string(),
  method: z.enum(REPORT_METHODS),
  targetId: z.string(),
  targetName: z.string().nullable(),
  targetBot: z.boolean(),
  targetRoleIds: z.array(z.string()).nullable(),
  source: sourceSchema.nullable(),
  message: messageEvidenceSchema.nullable(),
  messageLink: z.string().nullable(),
  attachment: attachmentMetaSchema.nullable(),
  reasonId: z.string().nullable(),
  answers: answersSchema.nullable(),
  filedReportId: z.string().nullable().default(null),
  createdAt: z.number(),
});

export type IntakeDraft = z.infer<typeof intakeDraftSchema>;
export type IntakeAnswers = z.infer<typeof answersSchema>;

function alreadyFiled(reportId: string): string {
  return `You already filed report \`${reportId}\` from this form.`;
}

export const METHOD_LABELS: Record<Exclude<ReportMethod, 'command'>, string> = {
  user_menu: 'Apps → Report user',
  message_menu: 'Apps → Report message',
  reaction: 'Reporting with a reaction',
};

export function methodLabel(
  labels: Pick<ModuleContext, 'commandLabel'>,
  method: ReportMethod,
): string {
  return method === 'command' ? `\`${labelOf(labels, REPORT_COMMAND)}\`` : METHOD_LABELS[method];
}

export function methodEnabled(reports: ReportsConfig, method: ReportMethod): boolean {
  switch (method) {
    case 'command':
      return reports.methods.command;
    case 'user_menu':
      return reports.methods.userMenu;
    case 'message_menu':
      return reports.methods.messageMenu;
    case 'reaction':
      return reports.methods.reaction;
  }
}

export function intakeGate(
  ctx: Pick<ModuleContext<ModerationConfig>, 'config' | 'commandLabel'>,
  method: ReportMethod,
): string | null {
  const { config } = ctx;
  if (!config.enabled) return MODERATION_OFF;
  if (!config.reports.enabled) return REPORTS_OFF;
  if (!methodEnabled(config.reports, method)) {
    const off = `${methodLabel(ctx, method)} is off in this server.`;
    if (method === 'reaction') return off;
    return `${off} ${method === 'command' ? COMMAND_OFF_HINT : METHOD_OFF_HINT}`;
  }
  return null;
}

export function lookupFailed(userId: string, status: number): string {
  return (
    `I couldn’t look up <@${userId}> right now (Discord answered ${status}), so nothing was ` +
    'filed. Try again.'
  );
}

export function immunityUnchecked(targetId: string): string {
  return (
    `I can’t check whether <@${targetId}> is exempt from reports right now, so nothing was ` +
    'filed. Try again in a moment.'
  );
}

export function isMemberReport(method: ReportMethod): boolean {
  return method === 'command' || method === 'user_menu';
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

function modalTitle(draft: IntakeDraft): string {
  const name = draft.targetName ? `@${draft.targetName}` : 'a member';
  const title = isMemberReport(draft.method) ? `Report ${name}` : `Report a message by ${name}`;
  return title.length <= MODAL_TITLE_MAX ? title : `${title.slice(0, MODAL_TITLE_MAX - 1)}…`;
}

export function uploadCapacity(reports: ReportsConfig, draft: IntakeDraft): number {
  return Math.max(0, reports.maxAttachments - (draft.attachment ? 1 : 0));
}

export function buildIntakeModal(
  reports: ReportsConfig,
  draft: IntakeDraft,
  target: { draftId: string; direct: boolean },
): Modal | null {
  const customId = target.direct
    ? encodeCustomId(MODULE_ID, REPORT_SUBMIT_DIRECT_ACTION, draft.guildId, target.draftId)
    : encodeCustomId(MODULE_ID, REPORT_SUBMIT_ACTION, target.draftId);
  if (!customId.ok) return null;

  const answers = draft.answers;
  const reasons = reports.reasons.slice(0, SELECT_OPTIONS_MAX);
  const selected = answers?.reasonId ?? draft.reasonId;
  const limits = reports.limits;
  const components: Record<string, unknown>[] = [];

  if (reasons.length > 0) {
    const required = reports.requireReason && !reports.allowCustomReason;

    components.push(
      labelled('Reason', null, {
        type: ComponentType.StringSelect,
        custom_id: INTAKE_FIELDS.reason,
        required,
        min_values: required ? 1 : 0,
        max_values: 1,
        placeholder: 'Choose a reason',
        options: reasons.map((reason) => ({
          label: reason.label.slice(0, 100),
          value: reason.id,
          ...(reason.description ? { description: reason.description.slice(0, 100) } : {}),
          ...(reason.id === selected ? { default: true } : {}),
        })),
      }),
    );
  }

  if (reports.allowCustomReason) {
    components.push(
      labelled(reasons.length > 0 ? 'Or describe the reason' : 'Reason', null, {
        type: ComponentType.TextInput,
        custom_id: INTAKE_FIELDS.custom,
        style: TextInputStyle.Short,
        required: reports.requireReason && reasons.length === 0,
        max_length: limits.customReasonMax,
        ...(answers?.custom ? { value: answers.custom.slice(0, limits.customReasonMax) } : {}),
      }),
    );
  }

  components.push(
    labelled(
      'Details',
      `${reports.requireComment ? 'Required' : 'Optional'}. Staff can see this. The member you report can’t.`,
      {
        type: ComponentType.TextInput,
        custom_id: INTAKE_FIELDS.comment,
        style: TextInputStyle.Paragraph,
        required: reports.requireComment,
        ...(reports.requireComment ? { min_length: requiredCommentLength(reports) } : {}),
        max_length: limits.commentMax,
        ...(answers?.comment ? { value: answers.comment.slice(0, limits.commentMax) } : {}),
      },
    ),
  );

  const capacity = uploadCapacity(reports, draft);
  if (capacity > 0) {
    const needed = reports.requireAttachment && draft.attachment === null;

    components.push(
      labelled('Screenshots or files', needed ? 'Attach at least one.' : 'Optional.', {
        type: ComponentType.FileUpload,
        custom_id: INTAKE_FIELDS.files,
        required: needed,
        min_values: needed ? 1 : 0,
        max_values: capacity,
      }),
    );
  }

  if (isMemberReport(draft.method)) {
    const links = answers?.links ?? draft.messageLink ?? '';

    components.push(
      labelled('Message links', 'Up to 3 links to messages in this server, one per line.', {
        type: ComponentType.TextInput,
        custom_id: INTAKE_FIELDS.links,
        style: TextInputStyle.Paragraph,
        required: false,
        max_length: LINKS_INPUT_MAX,
        ...(links ? { value: links.slice(0, LINKS_INPUT_MAX) } : {}),
      }),
    );
  }

  return {
    customId: customId.customId,
    title: modalTitle(draft),
    components: components.slice(0, 5),
  };
}

function actionButton(customId: string, label: string): Record<string, unknown> {
  return {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Primary, label, custom_id: customId },
    ],
  };
}

export function finishButton(guildId: string, draftId: string): Record<string, unknown> | null {
  const customId = encodeCustomId(MODULE_ID, REPORT_FINISH_ACTION, guildId, draftId);
  return customId.ok ? actionButton(customId.customId, 'Finish report') : null;
}

function retryButton(
  guildId: string,
  draftId: string,
  direct: boolean,
): Record<string, unknown> | null {
  const customId = direct
    ? encodeCustomId(MODULE_ID, REPORT_FINISH_ACTION, guildId, draftId)
    : encodeCustomId(MODULE_ID, REPORT_RETRY_ACTION, draftId);
  return customId.ok ? actionButton(customId.customId, 'Try again') : null;
}

async function run(
  ctx: ModuleContext<ModerationConfig>,
  request: ActionRequest,
): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `moderation could not answer a report interaction: ${
        result.failure?.humanReason ?? 'Discord gave no reason.'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

function status(body: StatusBody, components?: Record<string, unknown>[]) {
  return {
    content: body.content,
    embeds: body.embeds,
    ...(components && components.length > 0 ? { components } : {}),
    allowedMentions: { parse: [] },
  };
}

export interface IntakeStart {
  method: ReportMethod;
  targetId: string;
  targetName: string | null;
  targetBot: boolean;
  targetRoleIds: string[] | null;
  source: ReportSource | null;
  message: MessageEvidence | null;
  messageLink: string | null;
  attachment: IntakeDraft['attachment'];
}

type InvokerContext = Omit<CommandContext<ModerationConfig>, 'options'>;

function invokerTo(ctx: InvokerContext): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: { ...ctx.interaction, type: InteractionType.ApplicationCommand },
  };
}

export async function refuseInvoker(ctx: InvokerContext, message: string): Promise<void> {
  await run(ctx, replyEphemeral(invokerTo(ctx), status(errorStatus(message))));
}

function firstRefusal(...checks: IntakeCheck[]): string | null {
  for (const check of checks) {
    if (!check.ok) return check.message;
  }
  return null;
}

export async function startIntake(
  ctx: InvokerContext,
  deps: ModerationDeps,
  start: IntakeStart,
): Promise<void> {
  const gate = intakeGate(ctx, start.method);
  if (gate) return refuseInvoker(ctx, gate);

  const refusal = firstRefusal(
    validateReporter(
      ctx.config,
      {
        id: ctx.userId,
        roleIds: ctx.actorRoleIds ?? null,
        permissions: ctx.actorPermissions ?? null,
      },
      ctx.guildId,
    ),
    validateTarget(ctx.config, {
      reporterId: ctx.userId,
      targetId: start.targetId,
      targetBot: start.targetBot,
      targetRoleIds: start.targetRoleIds,
    }),
  );
  if (refusal) return refuseInvoker(ctx, refusal);

  if (!deps.reports) return refuseInvoker(ctx, REPORT_STORE_UNBOUND);
  if (!deps.drafts) return refuseInvoker(ctx, DRAFTS_UNBOUND);

  const draftId = newDraftId();
  const draft: IntakeDraft = {
    kind: 'report',
    guildId: ctx.guildId,
    actorId: ctx.userId,
    method: start.method,
    targetId: start.targetId,
    targetName: start.targetName,
    targetBot: start.targetBot,
    targetRoleIds: start.targetRoleIds,
    source: start.source,
    message: start.message,
    messageLink: start.messageLink,
    attachment: start.attachment,
    reasonId: null,
    answers: null,
    filedReportId: null,
    createdAt: deps.now?.() ?? Date.now(),
  };

  const modal = buildIntakeModal(ctx.config.reports, draft, { draftId, direct: false });
  if (!modal) return refuseInvoker(ctx, 'I couldn’t build the report form, so nothing was filed.');

  await deps.drafts.put(ctx.guildId, draftId, draft, DRAFT_TTL_MS);
  await run(ctx, openModal(invokerTo(ctx), modal));
}

type Roles = { ok: true; roleIds: string[] | null } | { ok: false; message: string };

function fromLookup(userId: string, found: MemberLookup): Roles {
  if (found.state === 'member') return { ok: true, roleIds: found.roleIds };
  if (found.state === 'absent') return { ok: true, roleIds: null };
  return { ok: false, message: lookupFailed(userId, found.status) };
}

export async function targetRolesAtSubmit(
  deps: ModerationDeps,
  guildId: string,
  draft: Pick<IntakeDraft, 'targetId' | 'targetRoleIds' | 'method'>,
): Promise<Roles> {
  if (deps.lookupMember) {
    return fromLookup(draft.targetId, await deps.lookupMember(guildId, draft.targetId));
  }

  if (isMemberReport(draft.method)) return { ok: true, roleIds: draft.targetRoleIds };

  return { ok: false, message: immunityUnchecked(draft.targetId) };
}

async function reporterRolesInDm(
  deps: ModerationDeps,
  guildId: string,
  userId: string,
): Promise<{ ok: true; roleIds: string[] } | { ok: false; message: string }> {
  if (!deps.lookupMember) {
    return {
      ok: false,
      message: 'I can’t check your roles in that server right now, so nothing was filed.',
    };
  }

  const found = await deps.lookupMember(guildId, userId);
  if (found.state === 'member') return { ok: true, roleIds: found.roleIds };
  if (found.state === 'absent') {
    return {
      ok: false,
      message: 'You’re no longer a member of that server, so the report wasn’t filed.',
    };
  }
  return { ok: false, message: lookupFailed(userId, found.status) };
}

export function basePermissions(
  state: GuildState | null,
  userId: string,
  roleIds: readonly string[],
): bigint | null {
  if (!state) return null;

  return computeBasePermissions({
    guildOwnerId: state.ownerId,
    everyoneRoleId: state.everyoneRoleId,
    memberId: userId,
    memberRoleIds: roleIds,
    roles: state.roles,
  });
}

export function requiredCommentLength(reports: ReportsConfig): number {
  if (!reports.requireComment) return 0;
  return Math.min(Math.max(1, reports.limits.commentMin), reports.limits.commentMax);
}

export function requirementProblems(
  reports: ReportsConfig,
  draft: IntakeDraft,
  answers: IntakeAnswers,
  uploads: number,
): string[] {
  const problems: string[] = [];
  const hasReasons = reports.reasons.length > 0;

  if (reports.requireReason && answers.reasonId === null && answers.custom.length === 0) {
    problems.push(
      hasReasons && reports.allowCustomReason
        ? 'Pick a reason, or describe one in your own words.'
        : hasReasons
          ? 'Pick a reason.'
          : reports.allowCustomReason
            ? 'Describe the reason.'
            : 'This server hasn’t set up any report reasons, so reports can’t be filed yet. Let staff know.',
    );
  }

  if (answers.custom.length > reports.limits.customReasonMax) {
    problems.push(`Keep the reason under ${reports.limits.customReasonMax} characters.`);
  }

  const { commentMax } = reports.limits;
  const commentMin = requiredCommentLength(reports);
  const comment = answers.comment.length;

  if (reports.requireComment && comment === 0) {
    problems.push('Add some details. This server asks for them with every report.');
  } else if (reports.requireComment && comment < commentMin) {
    problems.push(`Add a little more detail (at least ${commentMin} characters).`);
  }

  if (comment > commentMax) problems.push(`Keep the details under ${commentMax} characters.`);

  const capacity = uploadCapacity(reports, draft);
  if (reports.requireAttachment && draft.attachment === null && uploads === 0) {
    problems.push('Attach at least one screenshot or file. This server asks for one.');
  }
  if (uploads > capacity) problems.push(`Attach at most ${capacity} files.`);

  if (isMemberReport(draft.method)) problems.push(...readLinkLines(answers.links).problems);

  return problems;
}

function draftTtl(draft: IntakeDraft): number {
  return draft.method === 'reaction' ? REACTION_DRAFT_TTL_MS : DRAFT_TTL_MS;
}

function draftIdOf(action: string, args: readonly string[]): string | null {
  const id =
    action === REPORT_SUBMIT_DIRECT_ACTION || action === REPORT_FINISH_ACTION ? args[1] : args[0];
  return id && DRAFT_ID_PATTERN.test(id) ? id : null;
}

export async function handleIntakeSubmit(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<void> {
  const modal = readModalInteraction(event);
  const parsed = parseCustomId(modal?.customId);
  if (!modal || !parsed || parsed.moduleId !== MODULE_ID) return;

  const direct = parsed.action === REPORT_SUBMIT_DIRECT_ACTION;
  if (!direct && parsed.action !== REPORT_SUBMIT_ACTION) return;
  if (direct && parsed.args[0] !== ctx.guildId) return;

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: modal.userId,
    interaction: interactionRef(modal),
  };

  const deferred = deferEphemeral(to);
  await run(
    ctx,
    direct
      ? {
          ...deferred,
          payload: { ...(deferred.payload as Record<string, unknown>), ephemeral: false },
        }
      : deferred,
  );

  const applicationId = modal.applicationId ?? deps.applicationId;
  const say = async (body: StatusBody, components?: Record<string, unknown>[]) => {
    if (!applicationId) {
      ctx.logger.error(
        'a report form was submitted but Proton has no application id to answer it with, so the ' +
          'member was told nothing.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    await run(
      ctx,
      followUp({ ...to, applicationId }, { ...status(body, components), ephemeral: !direct }),
    );
  };

  if (!ctx.config.enabled) return say(errorStatus(MODERATION_OFF));

  const drafts = deps.drafts;
  if (!drafts) return say(errorStatus(DRAFTS_UNBOUND));

  const draftId = draftIdOf(parsed.action, parsed.args);
  const draft = draftId ? await drafts.get(ctx.guildId, draftId, intakeDraftSchema) : null;
  if (!draftId || !draft || draft.guildId !== ctx.guildId) return say(errorStatus(DRAFT_EXPIRED));
  if (draft.actorId !== modal.userId) return say(errorStatus(DRAFT_NOT_YOURS));

  if (draft.filedReportId !== null) {
    const replayed = await deps.reports?.byIdempotency(
      ctx.guildId,
      `interaction:${modal.interactionId}`,
    );
    if (!replayed) return say(successStatus(alreadyFiled(draft.filedReportId)));
  }

  const gate = intakeGate(ctx, draft.method);
  if (gate) return say(errorStatus(gate));

  let reporterRoleIds: string[];
  let reporterPermissions: bigint | null;
  const state = (await deps.guildState?.get(ctx.guildId)) ?? null;

  if (direct) {
    const roles = await reporterRolesInDm(deps, ctx.guildId, modal.userId);
    if (!roles.ok) return say(errorStatus(roles.message));
    reporterRoleIds = roles.roleIds;
    reporterPermissions = basePermissions(state, modal.userId, roles.roleIds);
  } else {
    reporterRoleIds = modal.roleIds ?? [];
    reporterPermissions = readMemberPermissions(event);
  }

  const reporterCheck = validateReporter(
    ctx.config,
    { id: modal.userId, roleIds: reporterRoleIds, permissions: reporterPermissions },
    ctx.guildId,
  );
  if (!reporterCheck.ok) return say(errorStatus(reporterCheck.message));

  const targetRoles = await targetRolesAtSubmit(deps, ctx.guildId, draft);
  if (!targetRoles.ok) return say(errorStatus(targetRoles.message));

  const targetCheck = validateTarget(ctx.config, {
    reporterId: modal.userId,
    targetId: draft.targetId,
    targetBot: draft.targetBot,
    targetRoleIds: targetRoles.roleIds,
  });
  if (!targetCheck.ok) return say(errorStatus(targetCheck.message));

  const reports = ctx.config.reports;
  const picked = modal.values[INTAKE_FIELDS.reason]?.[0] ?? null;
  const answers: IntakeAnswers = {
    reasonId:
      picked !== null && reports.reasons.some((reason) => reason.id === picked) ? picked : null,
    custom: (modal.fields[INTAKE_FIELDS.custom] ?? '').trim(),
    comment: (modal.fields[INTAKE_FIELDS.comment] ?? '').trim(),
    links: (modal.fields[INTAKE_FIELDS.links] ?? '').trim(),
  };

  const uploads = (modal.values[INTAKE_FIELDS.files] ?? []).flatMap((id) => {
    const attachment = modal.attachments.get(id);
    return attachment ? [attachmentMeta(attachment)] : [];
  });

  const problems = requirementProblems(reports, draft, answers, uploads.length);
  if (problems.length > 0) {
    await drafts.put(ctx.guildId, draftId, { ...draft, answers }, draftTtl(draft));
    const again = retryButton(ctx.guildId, draftId, direct);

    return say(
      errorStatus(`Your report wasn’t filed yet:\n${problems.map((p) => `- ${p}`).join('\n')}`),
      again ? [again] : undefined,
    );
  }

  const evidence: ReportEvidence = {
    ...(draft.message ? { message: draft.message } : {}),
    links: isMemberReport(draft.method)
      ? await captureLinks({
          guildId: ctx.guildId,
          reporterId: modal.userId,
          reporterRoleIds,
          lines: readLinkLines(answers.links).lines,
          state,
          readMessage: deps.readMessage,
        })
      : [],
    attachments: [...(draft.attachment ? [draft.attachment] : []), ...uploads].slice(
      0,
      reports.maxAttachments,
    ),
  };

  let outcome: SubmitOutcome;
  try {
    outcome = await submitReport(ctx, deps, {
      guildId: ctx.guildId,
      method: draft.method,
      reporter: { id: modal.userId, roleIds: reporterRoleIds },
      targetId: draft.targetId,
      reasonId: answers.reasonId,
      customReason: answers.custom
        ? clipStored(answers.custom, reports.limits.customReasonMax)
        : null,
      comment: answers.comment ? clipStored(answers.comment, reports.limits.commentMax) : null,
      source: draft.source,
      evidence,
      idempotencyKey: `interaction:${modal.interactionId}`,
      now: deps.now?.() ?? Date.now(),
    });
  } catch (error) {
    ctx.logger.error(`a report could not be saved: ${describeError(error)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await drafts.put(ctx.guildId, draftId, { ...draft, answers }, draftTtl(draft));
    const again = retryButton(ctx.guildId, draftId, direct);
    return say(errorStatus(SAVE_FAILED), again ? [again] : undefined);
  }

  if (outcome.status === 'refused') return say(errorStatus(outcome.message));

  await drafts.put(
    ctx.guildId,
    draftId,
    { ...draft, answers, filedReportId: outcome.report.id },
    draftTtl(draft),
  );
  return say(successStatus(outcome.message));
}

async function openDraftModal(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  expected: string,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || !parsed || parsed.moduleId !== MODULE_ID || parsed.action !== expected) return;

  const direct = press.guildId === null;
  if (expected === REPORT_FINISH_ACTION && parsed.args[0] !== ctx.guildId) return;

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: press.userId,
    interaction: interactionRef(press),
  };
  const answer = async (body: StatusBody): Promise<void> => {
    await run(ctx, replyEphemeral(to, status(body)));
  };

  if (!ctx.config.enabled) return answer(errorStatus(MODERATION_OFF));

  const drafts = deps.drafts;
  if (!drafts) return answer(errorStatus(DRAFTS_UNBOUND));

  const draftId = draftIdOf(parsed.action, parsed.args);
  const draft = draftId ? await drafts.get(ctx.guildId, draftId, intakeDraftSchema) : null;
  if (!draftId || !draft || draft.guildId !== ctx.guildId)
    return answer(errorStatus(DRAFT_EXPIRED));
  if (draft.actorId !== press.userId) return answer(errorStatus(DRAFT_NOT_YOURS));

  const gate = intakeGate(ctx, draft.method);
  if (gate) return answer(errorStatus(gate));

  if (draft.filedReportId !== null) return answer(successStatus(alreadyFiled(draft.filedReportId)));

  const modal = buildIntakeModal(ctx.config.reports, draft, { draftId, direct });
  if (!modal) return answer(errorStatus('I couldn’t build the report form, so nothing was filed.'));

  await run(ctx, openModal(to, modal));
}

export function handleRetry(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<void> {
  return openDraftModal(event, ctx, deps, REPORT_RETRY_ACTION);
}

export function handleFinish(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<void> {
  return openDraftModal(event, ctx, deps, REPORT_FINISH_ACTION);
}
