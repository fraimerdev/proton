import {
  type ActionRequest,
  type ActionResult,
  type AllowedMentions,
  type Attachment,
  defer as buildDefer,
  deferEphemeral as buildDeferEphemeral,
  followUp as buildFollowUp,
  openModal as buildOpenModal,
  replyEphemeral as buildReplyEphemeral,
  updateMessage as buildUpdateMessage,
  type CommandContext,
  type FollowUpTo,
  type InteractionMessage,
  type InteractionRef,
  isStatusBody,
  labelOf,
  MESSAGE_CONTENT_MAX,
  type Modal,
  type ModuleContext,
  type RespondTo,
  type StatusBody,
} from '@proton/core';
import { clipGraphemes } from '@proton/core/placeholders';
import { type GiveawaysConfig, MODULE_ID } from './config.ts';
import type { GiveawaysDeps } from './deps.ts';
import { type MessageComponent, V2_FLAGS } from './message.ts';

export { MODULE_ID } from './config.ts';

export const MENTIONS_OFF: AllowedMentions = { parse: [] };

export const NOT_WIRED =
  'I can’t run giveaways right now. Nothing was changed. This is a fault on my side, not a ' +
  'setting in this server.';

export type Ctx = ModuleContext<GiveawaysConfig>;

export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export function sentMessageId(result: ActionResult): string | null {
  const body = result.body;
  if (typeof body !== 'object' || body === null) return null;

  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function report(ctx: Ctx, attempt: string, result: ActionResult): void {
  if (succeeded(result)) return;

  ctx.logger.warn(
    `Giveaways could not ${attempt}: ${result.failure?.humanReason ?? 'no reason was reported'}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
  );
}

async function run(ctx: Ctx, request: ActionRequest, attempt: string): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);
  report(ctx, attempt, result);
  return result;
}

export interface ReplyOptions {
  ephemeral: boolean;
  allowedMentions?: AllowedMentions;
  suffix?: string;
}

function bodyOf(message: string | StatusBody): { content: string } | StatusBody {
  return typeof message === 'string' ? { content: message.slice(0, MESSAGE_CONTENT_MAX) } : message;
}

export async function reply(
  ctx: CommandContext<GiveawaysConfig>,
  message: string | StatusBody,
  options: ReplyOptions,
): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'interaction_reply',
      actorId: ctx.userId,
      idempotencyKey: `${ctx.idempotencyKey}:${options.suffix ?? 'reply'}`,
      dryRun: false,
      record: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        ...bodyOf(message),
        ephemeral: options.ephemeral,
        allowedMentions: options.allowedMentions ?? MENTIONS_OFF,
      },
    },
    'answer the invoker',
  );
}

// Ephemeral and never announced: an entrant export names every member who took part, so it goes
// to the person who asked and nowhere else.
export async function replyWithFile(
  ctx: CommandContext<GiveawaysConfig>,
  message: string | StatusBody,
  file: Attachment,
): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'interaction_reply',
      actorId: ctx.userId,
      idempotencyKey: `${ctx.idempotencyKey}:export`,
      dryRun: false,
      record: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        ...bodyOf(message),
        files: [file],
        ephemeral: true,
        allowedMentions: MENTIONS_OFF,
      },
    },
    'send the entrant export',
  );
}

export async function replyWithComponents(
  ctx: CommandContext<GiveawaysConfig>,
  content: string,
  components: MessageComponent[],
): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'interaction_reply',
      actorId: ctx.userId,
      idempotencyKey: `${ctx.idempotencyKey}:builder`,
      dryRun: false,
      record: false,
      payload: {
        interactionId: ctx.interaction.id,
        interactionToken: ctx.interaction.token,
        content: content.slice(0, MESSAGE_CONTENT_MAX),
        components,
        ephemeral: true,
        allowedMentions: MENTIONS_OFF,
      },
    },
    'open the giveaway builder',
  );
}

export interface CommandAnswer {
  answer(message: string | StatusBody, file?: Attachment): Promise<void>;
  refuse(message: string | StatusBody): Promise<void>;
}

export interface AcknowledgeOptions {
  path: string;
  ephemeral: boolean;
}

function followUpBody(
  message: string | StatusBody,
  ephemeral: boolean,
  file?: Attachment,
): InteractionMessage {
  return {
    ...bodyOf(message),
    ...(file ? { files: [file] } : {}),
    ephemeral,
    allowedMentions: MENTIONS_OFF,
  };
}

export async function acknowledgeCommand(
  ctx: CommandContext<GiveawaysConfig>,
  deps: Pick<GiveawaysDeps, 'applicationId'>,
  options: AcknowledgeOptions,
): Promise<CommandAnswer> {
  const { ephemeral } = options;
  const applicationId = ctx.applicationId ?? deps.applicationId;

  if (!applicationId) {
    return {
      async answer(message, file) {
        if (file) await replyWithFile(ctx, message, file);
        else await reply(ctx, message, { ephemeral });
      },
      async refuse(message) {
        await reply(ctx, message, { ephemeral: true });
      },
    };
  }

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: ctx.idempotencyKey,
  };

  await run(
    ctx,
    buildDefer(to, { ephemeral }),
    'acknowledge the command within the three seconds Discord allows',
  );

  const target: FollowUpTo = { ...to, applicationId };
  const say = (body: InteractionMessage, slot: string): Promise<ActionResult> =>
    run(ctx, buildFollowUp(target, body, slot), 'answer the invoker');

  return {
    async answer(message, file) {
      await say(followUpBody(message, ephemeral, file), 'answer');
    },
    async refuse(message) {
      if (ephemeral) {
        await say(followUpBody(message, true), 'answer');
        return;
      }

      const label = labelOf(ctx, 'giveaway', options.path);

      // The first followup fills the public "thinking…" message whatever its own flag says.
      const notice = await say(
        {
          content: `\`${label}\` didn’t go through.`,
          ephemeral: false,
          allowedMentions: MENTIONS_OFF,
        },
        'answer',
      );

      if (!succeeded(notice)) {
        ctx.logger.warn(
          `Giveaways did not tell the invoker why ${label} didn’t finish: the public notice did ` +
            'not post, so the private reason would have gone out publicly in its place.',
          { guildId: ctx.guildId, moduleId: MODULE_ID, code: notice.failure?.code },
        );
        return;
      }

      await say(followUpBody(message, true), 'detail');
    },
  };
}

export async function acknowledgeToggleable(
  ctx: CommandContext<GiveawaysConfig>,
  deps: Pick<GiveawaysDeps, 'applicationId'>,
  path: string,
): Promise<CommandAnswer> {
  return acknowledgeCommand(ctx, deps, { path, ephemeral: ctx.privateReply ?? true });
}

export function respondTo(
  ctx: Ctx,
  interaction: InteractionRef,
  actorId: string,
  root: string,
): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId,
    interaction,
    idempotencyKey: `${MODULE_ID}:${root}`,
  };
}

export async function acknowledge(
  ctx: Ctx,
  interaction: InteractionRef,
  actorId: string,
  root: string,
): Promise<ActionResult> {
  return run(
    ctx,
    buildDeferEphemeral(respondTo(ctx, interaction, actorId, root)),
    'acknowledge the button press within the three seconds Discord allows',
  );
}

export async function refuseNow(
  ctx: Ctx,
  interaction: InteractionRef,
  actorId: string,
  root: string,
  message: string | StatusBody,
): Promise<ActionResult> {
  return run(
    ctx,
    buildReplyEphemeral(respondTo(ctx, interaction, actorId, root), {
      ...bodyOf(message),
      allowedMentions: MENTIONS_OFF,
    }),
    'answer the button press',
  );
}

// A modal is a top-level interaction response, so it cannot follow a defer — opening one IS the
// three-second acknowledgement, and nothing before it may touch the database.
export async function showModal(
  ctx: Ctx,
  interaction: InteractionRef,
  actorId: string,
  root: string,
  modal: Modal,
): Promise<ActionResult> {
  return run(
    ctx,
    buildOpenModal(respondTo(ctx, interaction, actorId, root), modal),
    'open the builder modal',
  );
}

export async function updateInPlace(
  ctx: Ctx,
  interaction: InteractionRef,
  actorId: string,
  root: string,
  components: MessageComponent[],
  content?: string,
): Promise<ActionResult> {
  return run(
    ctx,
    buildUpdateMessage(respondTo(ctx, interaction, actorId, root), {
      ...(content !== undefined ? { content: content.slice(0, MESSAGE_CONTENT_MAX) } : {}),
      // No IS_COMPONENTS_V2 here on purpose: a modal cannot follow a defer, and a deferred
      // response cannot create a V2 message, so the builder stays on ordinary action rows.
      components,
      allowedMentions: MENTIONS_OFF,
    }),
    'update the builder',
  );
}

export type FollowUpBody =
  | string
  | StatusBody
  | { components: MessageComponent[]; flags?: number; content?: string };

export async function tellEntrant(
  ctx: Ctx,
  target: { applicationId: string; interaction: InteractionRef },
  actorId: string,
  root: string,
  body: FollowUpBody,
): Promise<ActionResult> {
  // A Components V2 followup refuses embeds, so the components branch never gains a status embed.
  const message =
    typeof body === 'string' || isStatusBody(body)
      ? bodyOf(body)
      : {
          ...(body.content !== undefined
            ? { content: body.content.slice(0, MESSAGE_CONTENT_MAX) }
            : {}),
          components: body.components,
          ...(body.flags !== undefined ? { flags: body.flags } : {}),
        };

  return run(
    ctx,
    buildFollowUp(
      { ...respondTo(ctx, target.interaction, actorId, root), applicationId: target.applicationId },
      { ...message, ephemeral: true, allowedMentions: MENTIONS_OFF },
    ),
    'tell the member whether they are in the draw',
  );
}

export interface PostInput {
  channelId: string;
  actorId: string;
  components: MessageComponent[];
  idempotencyKey: string;
}

export async function postGiveaway(ctx: Ctx, input: PostInput): Promise<ActionResult> {
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
        components: input.components,
        flags: V2_FLAGS,
        allowedMentions: MENTIONS_OFF,
      },
    },
    'post the giveaway message',
  );
}

export interface EditInput {
  channelId: string;
  messageId: string;
  actorId: string;
  components: MessageComponent[];
  idempotencyKey: string;
}

export async function editGiveaway(ctx: Ctx, input: EditInput): Promise<ActionResult> {
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
        components: input.components,
      },
    },
    'edit the giveaway message',
  );
}

export interface AnnounceInput {
  channelId: string;
  actorId: string;
  content: string;
  ping: readonly string[];
  components?: MessageComponent[];
  idempotencyKey: string;
}

export async function announceWinners(ctx: Ctx, input: AnnounceInput): Promise<ActionResult> {
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
        content: input.content.slice(0, MESSAGE_CONTENT_MAX),
        ...(input.components ? { components: input.components } : {}),
        // parse: [] with an explicit users list: the winners are pinged and nothing a member put
        // in the prize text — @everyone, a role — can be.
        allowedMentions: { parse: [], users: [...input.ping] },
      },
    },
    'announce the winners',
  );
}

// Two executor calls, both through the REST proxy: open the DM channel, then send into it.
// ActionResult.body carries the channel id back, which is what makes the second call possible.
/**
 * Gives a winner the configured reward role. The executor hierarchy-checks `add_role`, so a role
 * above the bot fails the precheck rather than 403ing — the refusal is returned so the host can be
 * told, because a reward that silently never lands is worse than no reward.
 */
export async function grantRewardRole(
  ctx: Ctx,
  userId: string,
  roleId: string,
  idempotencyKey: string,
): Promise<{ ok: true } | { ok: false; humanReason: string }> {
  const result = await run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'add_role',
      actorId: userId,
      targetId: userId,
      idempotencyKey,
      dryRun: false,
      record: false,
      payload: { userId, roleId },
    },
    'give a winner their reward role',
  );

  if (succeeded(result)) return { ok: true };

  return {
    ok: false,
    humanReason: result.failure?.humanReason ?? 'Discord refused the role change.',
  };
}

export async function dmWinner(
  ctx: Ctx,
  userId: string,
  content: string,
  idempotencyRoot: string,
): Promise<'sent' | 'closed-dms' | 'failed'> {
  const opened = await run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: userId,
      targetId: userId,
      idempotencyKey: `${idempotencyRoot}:dm-open`,
      dryRun: false,
      record: false,
      payload: { userId },
    },
    'open a direct message with a winner',
  );

  if (opened.status !== 'executed') return 'closed-dms';

  const channelId = sentMessageId(opened);
  if (channelId === null) return 'failed';

  const sent = await run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: userId,
      idempotencyKey: `${idempotencyRoot}:dm-send`,
      dryRun: false,
      record: false,
      payload: {
        channelId,
        content: clipGraphemes(content, MESSAGE_CONTENT_MAX),
        allowedMentions: MENTIONS_OFF,
        directMessage: true,
      },
    },
    'send a winner their direct message',
  );

  return sent.status === 'executed' ? 'sent' : 'failed';
}

export async function notifyHost(
  ctx: Ctx,
  channelId: string,
  actorId: string,
  content: string,
  idempotencyKey: string,
): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId,
      idempotencyKey,
      dryRun: false,
      record: false,
      payload: {
        channelId,
        content: content.slice(0, MESSAGE_CONTENT_MAX),
        allowedMentions: MENTIONS_OFF,
      },
    },
    'tell the host that a draw ran without one of its requirements',
  );
}

export interface LedgerInput {
  giveawayId: string;
  actorId: string;
  targetId?: string;
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

// PLAN.md I1: a draw is a state change, so it belongs in the ledger like every other one. The
// kind is ledger-only — the announcement that follows is a separate send with its own key.
export async function recordDrawCase(ctx: Ctx, input: LedgerInput): Promise<ActionResult> {
  return run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'giveaway_draw',
      actorId: input.actorId,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      dryRun: false,
      payload: input.payload,
    },
    'record the draw in the case ledger',
  );
}
