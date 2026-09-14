import {
  type ActionRequest,
  type AllowedMentions,
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  followUp,
  hasWithAdmin,
  Permissions,
  type RespondTo,
  replyEphemeral,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import {
  AFK_EXPIRE_JOB,
  AFK_RETENTION_MS,
  type AfkConfig,
  MODULE_ID,
  REASON_MAX,
} from './config.ts';
import { type AfkDeps, describeUnbound } from './deps.ts';
import { normaliseReason } from './reason.ts';
import {
  escapeMarkdown,
  isTagged,
  nicknameProblem,
  renderRecapNote,
  tagNickname,
} from './render.ts';
import { endSession, expiryKey, failureOf, memberExecutor, succeeded, untag } from './session.ts';
import type { AfkStatus, AfkStore } from './store.ts';

type Command = CommandDefinition<AfkConfig>;
type Ctx = CommandContext<AfkConfig>;

const MENTIONS_OFF: AllowedMentions = { parse: [] };

const NOT_WIRED =
  'I can’t run AFK right now. Nothing was changed. This is a fault on my side, not a setting in ' +
  'this server.';

const DISABLED =
  'AFK is switched off in this server. An admin can turn the AFK module on from the Proton ' +
  'dashboard.';

const NEEDS_MANAGE_NICKNAMES =
  "You need the Manage Nicknames permission to clear someone else's AFK.";

const SET_FOLLOWUP =
  "I'll tell people who ping you, and clear it when you next send a message in this server.";

const ENDED_WHILE_SETTING = 'Your AFK already ended: you sent a message while it was being set.';

function respondTo(ctx: Ctx): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: { id: ctx.interaction.id, token: ctx.interaction.token },
    idempotencyKey: ctx.idempotencyKey,
  };
}

async function run(ctx: Ctx, request: ActionRequest): Promise<void> {
  const result = await ctx.executor.execute(request);
  if (result.status !== 'failed_precheck' && result.status !== 'failed_api') return;

  ctx.logger.warn(
    `AFK could not answer the member who ran /afk: ${failureOf(result).humanReason}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
  );
}

function say(ctx: Ctx, applicationId: string, content: string): Promise<void> {
  return run(
    ctx,
    followUp({ ...respondTo(ctx), applicationId }, { content, allowedMentions: MENTIONS_OFF }),
  );
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

async function bookExpiry(ctx: Ctx, status: AfkStatus): Promise<void> {
  const meta = { guildId: ctx.guildId, moduleId: MODULE_ID, userId: status.userId };

  if (typeof ctx.schedule !== 'function') {
    ctx.logger.error(
      'AFK started a status in this server but this process has no scheduler, so it will not ' +
        'expire after 30 days. The worker must be started with a scheduled-action store.',
      meta,
    );
    return;
  }

  try {
    await ctx.schedule(
      AFK_EXPIRE_JOB,
      new Date(status.since.getTime() + AFK_RETENTION_MS),
      expiryKey(status),
      { userId: status.userId, sessionId: status.sessionId },
      { replace: true },
    );
  } catch (error) {
    ctx.logger.error(
      `AFK could not book the 30-day expiry for ${status.userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      meta,
    );
  }
}

type TagOutcome = { status: 'done' } | { status: 'refused'; problem: string } | { status: 'ended' };

const TAG_DONE: TagOutcome = { status: 'done' };

async function tag(ctx: Ctx, store: AfkStore, status: AfkStatus): Promise<TagOutcome> {
  if (ctx.actorNick === undefined) return TAG_DONE;
  const base = ctx.actorNick ?? ctx.actorDisplayName;
  if (base === undefined || isTagged(base)) return TAG_DONE;

  const tagged = tagNickname(base);

  const result = await memberExecutor(ctx, ctx.actorRoleIds).execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_member_nickname',
    targetId: ctx.userId,
    actorId: ctx.userId,
    reason: 'AFK tag',
    payload: { nickname: tagged },
    dryRun: false,
    record: false,
    idempotencyKey: `afk:${ctx.guildId}:${status.sessionId}:tag`,
  });

  if (!succeeded(result)) {
    return { status: 'refused', problem: nicknameProblem(failureOf(result), 'your') };
  }
  if (await store.recordTag(status.sessionId, tagged)) return TAG_DONE;

  const undone = await untag(ctx, status, ctx.userId, ctx.actorRoleIds);
  if (undone.status === 'failed') {
    ctx.logger.warn(
      `AFK tagged ${ctx.userId} just as their status ended, and could not take [AFK] back off: ${nicknameProblem(undone.failure, 'their')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: ctx.userId },
    );
  }

  return { status: 'ended' };
}

async function set(ctx: Ctx, store: AfkStore, applicationId: string): Promise<void> {
  const parsed = normaliseReason(ctx.options.getString('reason'));
  if (!parsed.ok) return say(ctx, applicationId, parsed.humanReason);

  const reason = parsed.reason;
  const sessionId = ctx.interaction.id;
  const updated = reason
    ? `Updated your AFK reason: ${escapeMarkdown(reason)}`
    : 'Removed your AFK reason.';

  const existing = await store.get(ctx.guildId, ctx.userId);
  if (existing?.sessionId === sessionId && existing.endedAt !== null) return;

  if (existing && existing.sessionId !== sessionId) {
    if (existing.endedAt === null) {
      await store.updateReason(ctx.guildId, ctx.userId, reason);
      return say(ctx, applicationId, updated);
    }

    await store.remove(existing.sessionId);
  }

  const { status } = await store.start({
    guildId: ctx.guildId,
    userId: ctx.userId,
    sessionId,
    reason,
    since: new Date(),
    previousNick: ctx.actorNick ?? null,
  });

  if (status.sessionId !== sessionId) {
    await store.updateReason(ctx.guildId, ctx.userId, reason);
    return say(ctx, applicationId, updated);
  }

  if (status.endedAt !== null) return;

  const confirmation = [
    status.reason ? `You're AFK: ${sentence(escapeMarkdown(status.reason))}` : "You're AFK.",
    SET_FOLLOWUP,
  ];

  await bookExpiry(ctx, status);

  const tagged = ctx.config.nicknameTag ? await tag(ctx, store, status) : TAG_DONE;
  if (tagged.status === 'ended') return say(ctx, applicationId, ENDED_WHILE_SETTING);
  if (tagged.status === 'refused') {
    confirmation.push(`I couldn't add [AFK] to your nickname: ${tagged.problem}`);
  }

  return say(ctx, applicationId, confirmation.join(' '));
}

async function clear(ctx: Ctx, store: AfkStore, applicationId: string): Promise<void> {
  const target = ctx.options.getUserId('member') ?? ctx.userId;
  const self = target === ctx.userId;

  if (!self && !hasWithAdmin(ctx.actorPermissions ?? 0n, Permissions.ManageNicknames)) {
    return say(ctx, applicationId, NEEDS_MANAGE_NICKNAMES);
  }

  const notAfk = self ? "You aren't AFK." : `<@${target}> isn't AFK.`;
  const endedBy = `command:${ctx.interaction.id}`;

  const status = await store.get(ctx.guildId, target);
  if (!status || (status.endedAt !== null && status.endedBy !== endedBy)) {
    return say(ctx, applicationId, notAfk);
  }

  const ended = await endSession(ctx, store, status, {
    endedBy,
    actorId: ctx.userId,
    currentNick: self ? ctx.actorNick : undefined,
    recap: self,
    targetRoleIds: self ? ctx.actorRoleIds : undefined,
    finish: 'tombstone',
  });

  if (!ended) return say(ctx, applicationId, notAfk);

  const problem =
    ended.nick.status === 'failed'
      ? nicknameProblem(ended.nick.failure, self ? 'your' : 'their')
      : null;

  if (self) {
    const parts = ['Your AFK is cleared.'];
    const note = renderRecapNote(ended.recap, ended.pingCount);
    if (note) parts.push(note);
    if (problem) parts.push(`I couldn't take [AFK] off your nickname: ${problem}`);
    return say(ctx, applicationId, parts.join(' '));
  }

  const parts = [`Cleared <@${target}>'s AFK.`];
  if (problem) parts.push(`I couldn't restore their nickname: ${problem}`);
  return say(ctx, applicationId, parts.join(' '));
}

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Tell people who ping you that you are away.')
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Mark yourself AFK in this server.')
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why you are away. Text only, no links.')
          .setRequired(false)
          .setMaxLength(REASON_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription('Clear your AFK, or with Manage Nicknames, someone else’s.')
      .addUserOption((option) =>
        option
          .setName('member')
          .setDescription('Whose AFK to clear. Leave empty for your own.')
          .setRequired(false),
      ),
  );

  return command;
}

export function afkCommand(deps: AfkDeps): Command {
  return {
    name: 'afk',
    description: 'Tell people who ping you that you are away.',

    data: builder().toJSON(),

    async handler(ctx) {
      const unbound = [
        ...(deps.store ? [] : ['store']),
        ...(deps.applicationId ? [] : ['applicationId']),
      ];

      if (unbound.length > 0) {
        ctx.logger.error(describeUnbound('the /afk command', unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
      }

      const { store, applicationId } = deps;
      if (!applicationId) return run(ctx, replyEphemeral(respondTo(ctx), NOT_WIRED));

      await run(ctx, deferEphemeral(respondTo(ctx)));

      if (!store) return say(ctx, applicationId, NOT_WIRED);
      if (!ctx.config.enabled) return say(ctx, applicationId, DISABLED);

      switch (ctx.options.getSubcommand()) {
        case 'set':
          return set(ctx, store, applicationId);
        case 'clear':
          return clear(ctx, store, applicationId);
        default:
          return say(ctx, applicationId, 'That subcommand is not one I know.');
      }
    },
  };
}

export function afkCommands(deps: AfkDeps): Command[] {
  return [afkCommand(deps)];
}
