import {
  type ActionRequest,
  type ActionResult,
  deferEphemeral as buildDeferEphemeral,
  deferUpdate as buildDeferUpdate,
  followUp as buildFollowUp,
  openModal as buildOpenModal,
  replyEphemeral as buildReplyEphemeral,
  type DiscordMessageBody,
  type InteractionRef,
  type MessageInput,
  type Modal,
  type ModuleContext,
  type RespondTo,
} from '@proton/core';
import { type MessagesConfig, MODULE_ID } from './config.ts';
import type { DiscordEmbed } from './embed.ts';

export { MODULE_ID } from './config.ts';

export type MessagesContext = ModuleContext<MessagesConfig>;

export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export function respondTo(
  ctx: MessagesContext,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId,
    interaction,
    idempotencyKey: `${MODULE_ID}:${idempotencyRoot}`,
  };
}

async function run(
  ctx: MessagesContext,
  request: ActionRequest,
  failed: string,
): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (!succeeded(result)) {
    ctx.logger.warn(`embeds could not ${failed}: ${result.failure?.humanReason ?? 'no reason'}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure?.code,
    });
  }

  return result;
}

export async function deferEphemeral(ctx: MessagesContext, to: RespondTo): Promise<ActionResult> {
  return run(ctx, buildDeferEphemeral(to), 'acknowledge an interaction');
}

export async function acknowledge(ctx: MessagesContext, to: RespondTo): Promise<ActionResult> {
  return run(ctx, buildDeferUpdate(to), 'acknowledge an interaction');
}

export async function replyEphemeral(
  ctx: MessagesContext,
  to: RespondTo,
  message: MessageInput,
): Promise<ActionResult> {
  return run(ctx, buildReplyEphemeral(to, message), 'answer the member');
}

export async function followUp(
  ctx: MessagesContext,
  to: RespondTo,
  applicationId: string,
  message: MessageInput,
): Promise<ActionResult> {
  return run(
    ctx,
    buildFollowUp({ ...to, applicationId }, message),
    'tell the member what happened',
  );
}

export async function openModal(
  ctx: MessagesContext,
  to: RespondTo,
  modal: Modal,
): Promise<ActionResult> {
  return run(ctx, buildOpenModal(to, modal), 'open the embed composer');
}

export const REASON_MAX = 512;

export interface RoleChangeReport {
  added: string[];
  removed: string[];

  failures: string[];
}

export interface ChangeRolesInput {
  userId: string;
  messageName: string;
  add: readonly string[];
  remove: readonly string[];

  idempotencyRoot: string;
}

export async function changeRoles(
  ctx: MessagesContext,
  input: ChangeRolesInput,
): Promise<RoleChangeReport> {
  const report: RoleChangeReport = { added: [], removed: [], failures: [] };

  const steps = [
    ...input.remove.map((roleId) => ({ kind: 'remove_role' as const, roleId })),
    ...input.add.map((roleId) => ({ kind: 'add_role' as const, roleId })),
  ];

  for (const step of steps) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: step.kind,
      actorId: input.userId,
      targetId: input.userId,
      reason: `Saved message '${input.messageName}': the member chose this themselves.`.slice(
        0,
        REASON_MAX,
      ),
      payload: { userId: input.userId, roleId: step.roleId },
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${input.idempotencyRoot}:${step.kind}:${step.roleId}`,
    });

    if (succeeded(result)) {
      (step.kind === 'add_role' ? report.added : report.removed).push(step.roleId);
    } else {
      const what = step.kind === 'add_role' ? 'giving you' : 'taking away';
      report.failures.push(
        `${what} <@&${step.roleId}>: ${result.failure?.humanReason ?? 'no reason was reported'}`,
      );
    }
  }

  return report;
}

export function describeReport(report: RoleChangeReport): string {
  const parts: string[] = [];

  if (report.added.length > 0) {
    parts.push(`Gave you ${report.added.map((id) => `<@&${id}>`).join(', ')}.`);
  }
  if (report.removed.length > 0) {
    parts.push(`Took away ${report.removed.map((id) => `<@&${id}>`).join(', ')}.`);
  }
  if (report.failures.length > 0) {
    parts.push(`I couldn't finish: ${report.failures.join(' | ')}`);
  }

  return parts.length > 0
    ? parts.join(' ')
    : 'Nothing changed — you already had exactly the roles that were set up here.';
}

export interface PostEmbedInput {
  channelId: string;
  embed: DiscordEmbed;
  actorId: string;

  idempotencyRoot: string;
}

export async function postEmbed(
  ctx: MessagesContext,
  input: PostEmbedInput,
): Promise<ActionResult> {
  return postMessage(ctx, {
    channelId: input.channelId,
    body: { embeds: [input.embed], allowedMentions: { parse: [] } },
    actorId: input.actorId,
    idempotencyRoot: input.idempotencyRoot,
  });
}

export interface PostMessageInput {
  channelId: string;
  body: DiscordMessageBody;
  actorId: string;

  idempotencyRoot: string;
}

export async function postMessage(
  ctx: MessagesContext,
  input: PostMessageInput,
): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: input.actorId,
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${input.idempotencyRoot}:post`,
      record: false,
      payload: { channelId: input.channelId, ...input.body },
    },
    `post a message in <#${input.channelId}>`,
  );
}
