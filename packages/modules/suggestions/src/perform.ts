import {
  type ActionRequest,
  type ActionResult,
  type AllowedMentions,
  deferEphemeral as buildDeferEphemeral,
  followUp as buildFollowUp,
  replyEphemeral as buildReplyEphemeral,
  type InteractionRef,
  type MessageInput,
  type ModuleContext,
  type RespondTo,
  THREAD_TYPE_PUBLIC,
} from '@proton/core';
import { MODULE_ID, type SuggestionsConfig } from './config.ts';
import type { Embed, MessageComponent } from './embed.ts';

export { MODULE_ID } from './config.ts';

export const MENTIONS_OFF: AllowedMentions = { parse: [] };

export const THREAD_ARCHIVE_MINUTES = 1440;

export const NOT_WIRED =
  "I can't finish that: this Proton deployment isn't fully set up, so I have no way to tell you " +
  'afterwards whether it worked. Nothing was changed. A server admin should check the Proton ' +
  'logs — the exact missing piece is named there.';

export type Ctx = ModuleContext<SuggestionsConfig>;

export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export function createdId(result: ActionResult): string | null {
  const body = result.body;
  if (typeof body !== 'object' || body === null) return null;

  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

export function whyItFailed(result: ActionResult): string {
  return result.failure?.humanReason ?? 'Discord refused it and gave no reason';
}

export function respondTo(
  ctx: Ctx,
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

async function run(ctx: Ctx, request: ActionRequest, attempt: string): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (!succeeded(result)) {
    ctx.logger.warn(`suggestions could not ${attempt}: ${whyItFailed(result)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure?.code,
    });
  }

  return result;
}

export async function acknowledge(ctx: Ctx, to: RespondTo): Promise<ActionResult> {
  return run(
    ctx,
    buildDeferEphemeral(to),
    'acknowledge the interaction within the three seconds Discord allows',
  );
}

export async function answer(
  ctx: Ctx,
  to: RespondTo,
  message: MessageInput,
): Promise<ActionResult> {
  const input = typeof message === 'string' ? { content: message } : message;

  return run(
    ctx,
    buildReplyEphemeral(to, { allowedMentions: MENTIONS_OFF, ...input }),
    'answer the member',
  );
}

export async function tell(
  ctx: Ctx,
  to: RespondTo,
  applicationId: string,
  message: MessageInput,
): Promise<ActionResult> {
  const input = typeof message === 'string' ? { content: message } : message;

  return run(
    ctx,
    buildFollowUp({ ...to, applicationId }, { allowedMentions: MENTIONS_OFF, ...input }),
    'tell the member what happened',
  );
}

export interface PostInput {
  channelId: string;
  actorId: string;
  embeds: Embed[];
  components: MessageComponent[];

  idempotencyKey: string;
}

export async function postSuggestion(ctx: Ctx, input: PostInput): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      dryRun: false,
      record: false,
      payload: {
        channelId: input.channelId,
        embeds: input.embeds,
        components: input.components,
        allowedMentions: MENTIONS_OFF,
      },
    },
    `post the suggestion in <#${input.channelId}>`,
  );
}

export interface EditInput {
  channelId: string;
  messageId: string;
  actorId: string;
  embeds: Embed[];
  components: MessageComponent[];

  idempotencyKey: string;
}

export async function editSuggestion(ctx: Ctx, input: EditInput): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'edit_message',
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      dryRun: false,
      record: false,
      payload: {
        channelId: input.channelId,
        messageId: input.messageId,
        embeds: input.embeds,
        components: input.components,
      },
    },
    'update the suggestion post',
  );
}

export interface ThreadInput {
  channelId: string;
  name: string;
  actorId: string;

  idempotencyKey: string;
}

export async function openThread(ctx: Ctx, input: ThreadInput): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_thread',
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      dryRun: false,
      record: false,
      payload: {
        channelId: input.channelId,
        name: input.name,
        // Explicit: Discord's start-thread endpoint still defaults to a private thread, which
        // nobody the suggestion was posted for would ever see.
        type: THREAD_TYPE_PUBLIC,
        autoArchiveDuration: THREAD_ARCHIVE_MINUTES,
      },
    },
    'open a discussion thread for the suggestion',
  );
}
