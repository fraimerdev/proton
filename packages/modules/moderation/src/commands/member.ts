import {
  type CommandContext,
  type CommandDefinition,
  encodeCustomId,
  errorStatus,
  hasWithAdmin,
  interactionRef,
  labelOf,
  type Modal,
  type ModuleContext,
  openModal,
  Permissions,
  type ProtonEvent,
  parseCustomId,
  readModalInteraction,
  snowflakeSchema,
  successStatus,
  tryParseDuration,
} from '@proton/core';
import { SlashCommandBuilder, type SlashCommandStringOption } from 'discord.js';
import { ComponentType, InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { DRAFT_TTL_MS, newDraftId } from '../drafts.ts';
import {
  acknowledged,
  deferTo,
  replyTo,
  respondTo,
  send,
  statusMessage,
  withCase,
} from '../interactions/respond.ts';
import { MODULE_ID, moderationReply, repliesPrivately } from '../perform.ts';
import { PUNISHMENT_ACTIONS } from '../placeholders.ts';
import type { PunishKind } from '../punish/config.ts';
import {
  durationInput,
  durationPrefill,
  FLOW_FIELDS,
  modalTitle,
  PUNISH_TITLES,
  reasonInput,
} from '../punish/flow.ts';
import { immuneRole } from '../punish/guard.ts';
import {
  type Channel,
  DRAFTS_UNBOUND,
  deliver,
  EXPIRED,
  executePending,
  followChannel,
  MODERATION_OFF,
  NOT_YOURS,
  type Pending,
  pendingIdOf,
  pendingSchema,
  presserOf,
  replyChannel,
  settledFromPunish,
  staleAnswer,
  storedOf,
} from '../punish/pending.ts';
import { banDurationOf, DUPLICATE_MESSAGE, punish, REASON_MAX } from '../punish/pipeline.ts';
import { expandReason } from '../punish/reasons.ts';
import {
  DIRECTION_NOUN,
  DIRECTION_VERB,
  KIND_PERMISSION,
  type UnpunishRequest,
} from '../punish/types.ts';
import { unpunish } from '../punish/unpunish.ts';
import { begin, commandTo } from './answer.ts';

type Command = CommandDefinition<ModerationConfig>;
type Ctx = CommandContext<ModerationConfig>;

export const REVIEW_ACTION = 'prv';

export const REVIEW_PRIVATE = 'e';
export const REVIEW_PUBLIC = 'p';

export const REASON_OPTION = 'reason';

const RECENT_WINDOW_FALLBACK_MS = 5 * 60_000;

function reasonOption(
  option: SlashCommandStringOption,
  description: string,
  autocomplete: boolean,
): SlashCommandStringOption {
  return option
    .setName(REASON_OPTION)
    .setDescription(description)
    .setMaxLength(REASON_MAX)
    .setAutocomplete(autocomplete);
}

async function refuse(ctx: Ctx, text: string): Promise<void> {
  await send(ctx, replyTo(commandTo(ctx), statusMessage(errorStatus(text)), repliesPrivately(ctx)));
}

interface Punishment {
  kind: PunishKind;
  targetId: string;
  reason: string | null;
  duration?: string | null;
  deleteMessageDays?: number;
}

function pendingOf(ctx: Ctx, punishment: Punishment, deps: ModerationDeps): Pending {
  return {
    kind: 'punish',
    guildId: ctx.guildId,
    actorId: ctx.userId,
    channelId: ctx.channelId,
    punishment: punishment.kind,
    targetId: punishment.targetId,
    reason: punishment.reason,
    ...(punishment.duration !== undefined ? { duration: punishment.duration } : {}),
    ...(punishment.deleteMessageDays !== undefined
      ? { deleteMessageDays: punishment.deleteMessageDays }
      : {}),
    proof: null,
    origin: { type: 'command' },
    confirmedRecentCase: false,
    note: null,
    reporterNote: null,
    publicResult: !repliesPrivately(ctx),
    invokerHadPermission: hasWithAdmin(
      ctx.actorPermissions ?? 0n,
      KIND_PERMISSION[punishment.kind],
    ),
    createdAt: deps.now?.() ?? Date.now(),
  };
}

async function addPunishment(
  ctx: Ctx,
  deps: ModerationDeps,
  punishment: Punishment,
): Promise<void> {
  if (ctx.config.punish.types[punishment.kind].alwaysReview) {
    return openReview(ctx, deps, punishment);
  }

  const channel = await begin(ctx, deps);
  const outcome = await punish(ctx, deps, {
    guildId: ctx.guildId,
    kind: punishment.kind,
    targetId: punishment.targetId,
    actor: {
      id: ctx.userId,
      roleIds: ctx.actorRoleIds ?? null,
      permissions: ctx.actorPermissions ?? null,
      kind: 'member',
    },
    ...(punishment.reason !== null ? { reason: punishment.reason } : {}),
    ...(punishment.duration !== undefined ? { duration: punishment.duration } : {}),
    ...(punishment.deleteMessageDays !== undefined
      ? { deleteMessageDays: punishment.deleteMessageDays }
      : {}),
    origin: { type: 'command' },
    channelId: ctx.channelId,
    idempotencyRoot: ctx.idempotencyKey,
  });

  await deliver(ctx, deps, channel, settledFromPunish(outcome, pendingOf(ctx, punishment, deps)), {
    resultEphemeral: repliesPrivately(ctx),
    actorId: ctx.userId,
  });
}

async function recentCase(
  ctx: Ctx,
  deps: ModerationDeps,
  punishment: Punishment,
): Promise<{ caseId: string; createdAt: number } | null> {
  const settings = ctx.config.punish.confirmRecentCase;
  if (!settings.enabled || !deps.ledger) return null;

  const now = deps.now?.() ?? Date.now();
  const window = tryParseDuration(settings.window) ?? RECENT_WINDOW_FALLBACK_MS;

  // Unread is not "none": the pending keeps confirmedRecentCase false, so the pipeline asks again.
  try {
    return await deps.ledger.recent(
      ctx.guildId,
      punishment.targetId,
      punishment.kind,
      new Date(now - window),
    );
  } catch {
    return null;
  }
}

function reviewModal(
  ctx: Ctx,
  punishment: Punishment,
  pendingId: string,
  recent: { caseId: string; createdAt: number } | null,
): Modal | null {
  const visibility = repliesPrivately(ctx) ? REVIEW_PRIVATE : REVIEW_PUBLIC;
  const customId = encodeCustomId(MODULE_ID, REVIEW_ACTION, pendingId, visibility);
  if (!customId.ok) return null;

  const { kind, targetId } = punishment;
  const settings = ctx.config.punish.types[kind];
  const name = ctx.resolved?.users.get(targetId)?.username ?? null;
  const who = name ? `@${name}` : 'this member';

  const summary = [
    `You're about to ${DIRECTION_VERB[kind]} ${who}. Check the details, then submit.`,
  ];
  if (recent) {
    const at = Math.floor(recent.createdAt / 1000);
    summary.push(
      `**${who} was already ${PUNISHMENT_ACTIONS[kind]} <t:${at}:R> (case ` +
        `\`${recent.caseId}\`).** Submit only if you mean to do it again.`,
    );
  }

  const typed = punishment.reason?.trim() ?? '';
  const reason = typed === '' ? settings.defaultReason : expandReason(ctx.config.punish, typed);

  const components: Record<string, unknown>[] = [
    { type: ComponentType.TextDisplay, content: summary.join('\n\n') },
    reasonInput(reason || null, settings.forceReason),
  ];

  if (kind === 'timeout' || kind === 'ban') {
    const typedDuration = punishment.duration;
    components.push(
      durationInput(
        kind,
        typedDuration === undefined ? durationPrefill(ctx.config, kind) : typedDuration,
      ),
    );
  }

  return {
    customId: customId.customId,
    title: modalTitle(PUNISH_TITLES[kind], name),
    components,
  };
}

async function openReview(ctx: Ctx, deps: ModerationDeps, punishment: Punishment): Promise<void> {
  const drafts = deps.drafts;
  if (!drafts) return refuse(ctx, DRAFTS_UNBOUND);

  const punishConfig = ctx.config.punish;
  const { kind, targetId } = punishment;
  const roles = ctx.resolved?.members.get(targetId)?.roleIds;

  if (!punishConfig.immunity.useHierarchy && roles) {
    const immune = immuneRole(punishConfig, kind, roles);
    if (immune) {
      return refuse(
        ctx,
        `<@${targetId}> has <@&${immune}>, which is immune to ${DIRECTION_NOUN[kind]}s in ` +
          'this server (Moderation → Immunity). Nothing was done.',
      );
    }
  }

  const recent = await recentCase(ctx, deps, punishment);
  const pendingId = newDraftId();
  const modal = reviewModal(ctx, punishment, pendingId, recent);
  if (!modal) return refuse(ctx, "I couldn't build the review form, so nothing was done.");

  await drafts.put(
    ctx.guildId,
    pendingId,
    { ...pendingOf(ctx, punishment, deps), confirmedRecentCase: recent !== null },
    DRAFT_TTL_MS,
  );
  await send(ctx, openModal(commandTo(ctx), modal));
}

export async function handleReview(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<void> {
  const modal = readModalInteraction(event);
  const parsed = parseCustomId(modal?.customId);
  if (!modal || parsed?.moduleId !== MODULE_ID || parsed.action !== REVIEW_ACTION) return;

  const to = respondTo(ctx.guildId, modal.userId, interactionRef(modal));
  // Not config.publicReplies: the command's own reply setting was resolved when the form opened.
  const visible = parsed.args[1] === REVIEW_PUBLIC;
  const applicationId = modal.applicationId ?? deps.applicationId;

  let channel: Channel;
  if (applicationId) {
    if (!acknowledged(await send(ctx, deferTo(to, !visible)))) return;
    channel = followChannel(ctx, to, applicationId, visible);
  } else {
    channel = replyChannel(ctx, to);
  }

  const say = (text: string) => channel.say(statusMessage(errorStatus(text)), 'result', !visible);

  if (!ctx.config.enabled) return say(MODERATION_OFF);

  const drafts = deps.drafts;
  if (!drafts) return say(DRAFTS_UNBOUND);

  const id = pendingIdOf(parsed.args[0]);
  const pending = id ? await drafts.get(ctx.guildId, id, pendingSchema) : null;

  if (!id || !pending || pending.guildId !== ctx.guildId) {
    return channel.say(await staleAnswer(drafts, ctx.guildId, id, EXPIRED), 'result', !visible);
  }
  if (pending.actorId !== modal.userId) return say(NOT_YOURS);

  const taken = await drafts.take(ctx.guildId, id, pendingSchema);
  if (!taken) {
    const message = await staleAnswer(drafts, ctx.guildId, id, DUPLICATE_MESSAGE);
    return channel.say(message, 'result', !visible);
  }

  const { duration: _typed, ...rest } = taken;
  const reason = (modal.fields[FLOW_FIELDS.reason] ?? '').trim();
  const duration = (modal.fields[FLOW_FIELDS.duration] ?? '').trim();
  const reviewed: Pending = {
    ...rest,
    reason: reason || null,
    ...(taken.punishment === 'ban' ? { duration: banDurationOf(duration) ?? null } : {}),
    ...(taken.punishment === 'timeout' && duration ? { duration } : {}),
  };

  const settled = await executePending(ctx, deps, reviewed, {
    id,
    presser: presserOf(event, modal),
    token: event.id,
  });

  await drafts.putOutcome(ctx.guildId, id, storedOf(settled));
  await deliver(ctx, deps, channel, settled, { resultEphemeral: !visible, actorId: modal.userId });
}

async function lift(
  ctx: Ctx,
  deps: ModerationDeps,
  request: Pick<UnpunishRequest, 'kind' | 'targetId' | 'caseId'> & { reason: string | null },
): Promise<void> {
  const channel = await begin(ctx, deps);
  const outcome = await unpunish(ctx, deps, {
    guildId: ctx.guildId,
    kind: request.kind,
    ...(request.targetId ? { targetId: request.targetId } : {}),
    ...(request.caseId ? { caseId: request.caseId } : {}),
    actor: {
      id: ctx.userId,
      roleIds: ctx.actorRoleIds ?? null,
      permissions: ctx.actorPermissions ?? null,
      kind: 'member',
    },
    ...(request.reason ? { reason: request.reason } : {}),
    origin: { type: 'command' },
    idempotencyRoot: ctx.idempotencyKey,
  });

  const body =
    outcome.status === 'executed'
      ? successStatus(withCase(outcome.summary, outcome.caseId))
      : errorStatus(outcome.message);

  await channel.say(statusMessage(body), 'result', repliesPrivately(ctx));
}

function reasonOf(ctx: Ctx): string | null {
  return ctx.options.getString(REASON_OPTION);
}

export function banCommand(deps: ModerationDeps): Command {
  return {
    name: 'ban',
    description: 'Ban a member, or lift a ban.',

    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member, or lift a ban.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.BanMembers)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Ban a member from this server.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to ban.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription(
                'Ban length, like 12h or 7d. Leave empty for the server default, or type permanent ' +
                  'to ban for good.',
              ),
          )
          .addIntegerOption((option) =>
            option
              .setName('delete_message_days')
              .setDescription('Days of their recent messages to delete, 0-7.')
              .setMinValue(0)
              .setMaxValue(7),
          )
          .addStringOption((option) =>
            reasonOption(option, 'Written to the Discord audit log and to the case.', true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Lift a ban on a user.')
          .addStringOption((option) =>
            option
              .setName('user_id')
              .setDescription(
                "ID of the banned user. They aren't in the server, so they can't be picked from a list.",
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            reasonOption(option, 'Written to the Discord audit log and to the case.', false),
          ),
      )
      .toJSON(),

    reply: moderationReply(['add', 'remove']),

    async handler(ctx) {
      if (!ctx.config.enabled) return refuse(ctx, MODERATION_OFF);

      switch (ctx.options.getSubcommand()) {
        case 'add':
          return addBan(ctx, deps);
        case 'remove':
          return removeBan(ctx, deps);
        default:
          return refuse(
            ctx,
            `Use ${labelOf(ctx, 'ban', 'add')} to ban someone, or ${labelOf(ctx, 'ban', 'remove')} ` +
              'to lift a ban.',
          );
      }
    },
  };
}

async function addBan(ctx: Ctx, deps: ModerationDeps): Promise<void> {
  const userId = ctx.options.getUserId('user');
  if (!userId) return refuse(ctx, 'I need a user to ban.');

  const duration = banDurationOf(ctx.options.getString('duration'));
  const days = ctx.options.getInteger('delete_message_days');

  return addPunishment(ctx, deps, {
    kind: 'ban',
    targetId: userId,
    reason: reasonOf(ctx),
    ...(duration !== undefined ? { duration } : {}),
    ...(days !== null ? { deleteMessageDays: days } : {}),
  });
}

async function removeBan(ctx: Ctx, deps: ModerationDeps): Promise<void> {
  const userId = ctx.options.getString('user_id')?.trim() ?? '';

  if (!snowflakeSchema.safeParse(userId).success) {
    return refuse(
      ctx,
      `'${userId}' isn't a Discord user ID. Turn on Developer Mode in Discord, open Server ` +
        'Settings → Bans, then right-click the user and choose Copy User ID.',
    );
  }

  return lift(ctx, deps, { kind: 'unban', targetId: userId, reason: reasonOf(ctx) });
}

export function warnCommand(deps: ModerationDeps): Command {
  return {
    name: 'warn',
    description: 'Warn a member, or withdraw a warning.',

    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member, or withdraw a warning.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ModerateMembers)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Record a warning against a member.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to warn.').setRequired(true),
          )
          .addStringOption((option) =>
            reasonOption(option, 'Shown in the case and to the member.', true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Withdraw a warning, so it stops counting against the member.')
          .addStringOption((option) =>
            option
              .setName('case')
              .setDescription('Case ID of the warning, shown under it (like K7f3M2q).')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addStringOption((option) =>
            reasonOption(option, 'Written to the case that records the withdrawal.', false),
          ),
      )
      .toJSON(),

    reply: moderationReply(['add', 'remove']),

    async handler(ctx) {
      if (!ctx.config.enabled) return refuse(ctx, MODERATION_OFF);

      switch (ctx.options.getSubcommand()) {
        case 'add': {
          const userId = ctx.options.getUserId('user');
          if (!userId) return refuse(ctx, 'I need a user to warn.');
          return addPunishment(ctx, deps, {
            kind: 'warn',
            targetId: userId,
            reason: reasonOf(ctx),
          });
        }
        case 'remove':
          return lift(ctx, deps, {
            kind: 'unwarn',
            caseId: ctx.options.getString('case')?.trim() ?? '',
            reason: reasonOf(ctx),
          });
        default:
          return refuse(
            ctx,
            `Use ${labelOf(ctx, 'warn', 'add')} to warn somebody, or ` +
              `${labelOf(ctx, 'warn', 'remove')} to withdraw a warning by its case ID.`,
          );
      }
    },
  };
}

export function kickCommand(deps: ModerationDeps): Command {
  return {
    name: 'kick',
    description: 'Remove a member from this server.',

    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Remove a member from this server.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.KickMembers)
      .addUserOption((option) =>
        option.setName('user').setDescription('The member to kick.').setRequired(true),
      )
      .addStringOption((option) =>
        reasonOption(option, 'Written to the Discord audit log and to the case.', true),
      )
      .toJSON(),

    reply: moderationReply(['']),

    async handler(ctx) {
      if (!ctx.config.enabled) return refuse(ctx, MODERATION_OFF);

      const userId = ctx.options.getUserId('user');
      if (!userId) return refuse(ctx, 'I need a member to kick.');

      return addPunishment(ctx, deps, { kind: 'kick', targetId: userId, reason: reasonOf(ctx) });
    },
  };
}

export function timeoutCommand(deps: ModerationDeps): Command {
  return {
    name: 'timeout',
    description: 'Time a member out, or end a timeout early.',

    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Time a member out, or end a timeout early.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ModerateMembers)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Time a member out for a while.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to time out.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription('How long, like 30m or 7d. Leave empty for the server default.'),
          )
          .addStringOption((option) =>
            reasonOption(option, 'Written to the Discord audit log and to the case.', true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('End a timeout early.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to release.').setRequired(true),
          )
          .addStringOption((option) =>
            reasonOption(option, 'Written to the Discord audit log and to the case.', false),
          ),
      )
      .toJSON(),

    reply: moderationReply(['add', 'remove']),

    async handler(ctx) {
      if (!ctx.config.enabled) return refuse(ctx, MODERATION_OFF);

      switch (ctx.options.getSubcommand()) {
        case 'add': {
          const userId = ctx.options.getUserId('user');
          if (!userId) return refuse(ctx, 'I need a member to time out.');

          const duration = ctx.options.getString('duration');
          return addPunishment(ctx, deps, {
            kind: 'timeout',
            targetId: userId,
            reason: reasonOf(ctx),
            ...(duration ? { duration } : {}),
          });
        }
        case 'remove': {
          const userId = ctx.options.getUserId('user');
          if (!userId) return refuse(ctx, 'I need a member to release.');
          return lift(ctx, deps, { kind: 'untimeout', targetId: userId, reason: reasonOf(ctx) });
        }
        default:
          return refuse(
            ctx,
            `Use ${labelOf(ctx, 'timeout', 'add')} to time somebody out, or ` +
              `${labelOf(ctx, 'timeout', 'remove')} to end a timeout early.`,
          );
      }
    },
  };
}

export function memberCommands(deps: ModerationDeps): Command[] {
  return [banCommand(deps), kickCommand(deps), timeoutCommand(deps), warnCommand(deps)];
}
