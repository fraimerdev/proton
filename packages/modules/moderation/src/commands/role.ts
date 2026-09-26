import {
  type CommandContext,
  type CommandDefinition,
  errorStatus,
  type GuildState,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  labelOf,
  newId,
  Permissions,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import {
  isRefusal,
  MODULE_ID,
  moderationReply,
  perform,
  type Refusal,
  repliesPrivately,
  reply,
} from '../perform.ts';
import { guardRole, guardTarget } from '../role-guard.ts';
import { ROLE_RUN_JOB, ROLE_RUN_KEY, renderProgress } from '../role-run.ts';
import type { RoleRun, RoleRunMode } from '../run-store.ts';
import { acknowledge } from './answer.ts';

type Command = CommandDefinition<ModerationConfig>;

const REASON_MAX = 512;

const MASS_MODES: Record<string, RoleRunMode> = {
  all: 'all',
  bots: 'bots',
  humans: 'humans',
  in: 'in',
};

export function roleCommand(deps: ModerationDeps): Command {
  return {
    name: 'role',
    description: 'Add or remove roles, for one member or many.',

    data: new SlashCommandBuilder()
      .setName('role')
      .setDescription('Add or remove roles, for one member or many.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles | Permissions.ModerateMembers)
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a role to a member.')
          .addUserOption((o) =>
            o.setName('user').setDescription('The member to add the role to.').setRequired(true),
          )
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to add.').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Written to the Discord audit log and to the case.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a role from a member.')
          .addUserOption((o) =>
            o
              .setName('user')
              .setDescription('The member to remove the role from.')
              .setRequired(true),
          )
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to remove.').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Written to the Discord audit log and to the case.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('all')
          .setDescription('Add a role to every member.')
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to add.').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Written to the Discord audit log on every grant.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('bots')
          .setDescription('Add a role to every bot.')
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to add.').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Written to the Discord audit log on every grant.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('humans')
          .setDescription('Add a role to every member except bots.')
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to add.').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Written to the Discord audit log on every grant.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('in')
          .setDescription('Add a role to every member who has another role.')
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to add.').setRequired(true),
          )
          .addRoleOption((o) =>
            o
              .setName('target_role')
              .setDescription('Members with this role get the new one.')
              .setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Written to the Discord audit log on every grant.')
              .setMaxLength(REASON_MAX),
          ),
      )
      .addSubcommand((s) =>
        s.setName('cancel').setDescription('Stop a mass role change that’s still running.'),
      )
      .toJSON(),

    reply: moderationReply(['add', 'remove', 'all', 'bots', 'humans', 'in', 'cancel']),

    async handler(ctx) {
      const sub = ctx.options.getSubcommand() ?? '';

      if (sub === 'add' || sub === 'remove') return one(ctx, deps, sub);

      const mode = MASS_MODES[sub];
      if (mode) return mass(ctx, deps, mode);

      if (sub === 'cancel') return cancel(ctx, deps);

      const label = (path: string) => labelOf(ctx, 'role', path);
      return reply(
        ctx,
        errorStatus(
          `Use ${label('add')} or ${label('remove')} for one member, or ${label('all')}, ` +
            `${label('bots')}, ${label('humans')} or ${label('in')} to give a role to many at once.`,
        ),
      );
    },
  };
}

// Returns the refusal: its callers may have deferred, so replying here would be a second callback.
async function guardedState(
  ctx: CommandContext<ModerationConfig>,
  deps: ModerationDeps,
  roleId: string,
): Promise<GuildState | Refusal> {
  if (!deps.guildState) {
    return {
      refusal:
        'I can’t read this server’s role list, so I can’t check that changing that role is ' +
        'allowed. Nothing was changed. This is a problem on my end, not a setting in this server.',
    };
  }

  const state = await deps.guildState.get(ctx.guildId);
  if (!state) {
    return {
      refusal:
        "I don't have this server's roles yet, so I can't check that changing that role is " +
        'allowed. Try again in a moment.',
    };
  }

  return guardRole({ state, roleId, actorId: ctx.userId, actorRoleIds: ctx.actorRoleIds }) ?? state;
}

async function defer(ctx: CommandContext<ModerationConfig>): Promise<boolean> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:defer`,
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      callbackType: INTERACTION_CALLBACK_DEFERRED_MESSAGE,
      ephemeral: repliesPrivately(ctx),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `/role could not be acknowledged, so it ran nothing and said nothing: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result.status === 'executed' || result.status === 'skipped_duplicate';
}

async function answer(
  ctx: CommandContext<ModerationConfig>,
  applicationId: string,
  message: string | StatusBody,
): Promise<void> {
  const body = typeof message === 'string' ? { content: message.slice(0, 2000) } : message;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_followup',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:answer`,
    dryRun: false,
    payload: {
      applicationId,
      interactionToken: ctx.interaction.token,
      ephemeral: repliesPrivately(ctx),
      ...body,
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `/role could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function one(
  ctx: CommandContext<ModerationConfig>,
  deps: ModerationDeps,
  sub: 'add' | 'remove',
): Promise<void> {
  const userId = ctx.options.getUserId('user');
  if (!userId) return reply(ctx, errorStatus('Pick the member whose roles you want to change.'));

  const roleId = ctx.options.getRoleId('role');
  if (!roleId) return reply(ctx, errorStatus('Pick a role to add or remove.'));

  const answer = await acknowledge(ctx, deps);

  const state = await guardedState(ctx, deps, roleId);
  if (isRefusal(state)) return answer(errorStatus(state.refusal));

  if (!deps.fetchMemberRoles) {
    return answer(
      errorStatus(
        `I can’t read <@${userId}>’s roles, so I can’t check that you outrank them. Nothing ` +
          'was changed. This is a problem on my end, not a setting in this server.',
      ),
    );
  }

  const targetRoleIds = await deps.fetchMemberRoles(ctx.guildId, userId);
  if (!targetRoleIds) {
    return answer(
      errorStatus(
        `I couldn't look up <@${userId}>'s roles, so I can't confirm you outrank them. This ` +
          'usually means they just left the server.',
      ),
    );
  }

  const outranked = guardTarget({
    state,
    actorId: ctx.userId,
    actorRoleIds: ctx.actorRoleIds,
    targetId: userId,
    targetRoleIds,
  });

  if (outranked) return answer(errorStatus(outranked.refusal));

  const reason = ctx.options.getString('reason');

  return perform(
    ctx,
    {
      kind: sub === 'add' ? 'add_role' : 'remove_role',
      targetId: userId,
      payload: { userId, roleId },
      ...(reason ? { reason } : {}),
      targetRoleIds,
      success:
        sub === 'add'
          ? `Gave <@&${roleId}> to <@${userId}>.`
          : `Took <@&${roleId}> off <@${userId}>.`,
    },
    answer,
  );
}

async function mass(
  ctx: CommandContext<ModerationConfig>,
  deps: ModerationDeps,
  mode: RoleRunMode,
): Promise<void> {
  const store = deps.roleRuns;
  const applicationId = deps.applicationId;

  if (!store || !deps.members || !applicationId || !ctx.schedule) {
    return reply(
      ctx,
      errorStatus(
        'I can’t run mass role changes right now, so nothing was changed. Use ' +
          `${labelOf(ctx, 'role', 'add')} for one member at a time.`,
      ),
    );
  }

  // Deferred before anything else: what follows posts a message, writes Redis and books a job,
  // and Discord closes the interaction three seconds after it arrives. Everything from here
  // answers as a followup.
  if (!(await defer(ctx))) return;

  const roleId = ctx.options.getRoleId('role');
  if (!roleId) return answer(ctx, applicationId, errorStatus('Pick a role to add.'));

  const targetRoleId = mode === 'in' ? ctx.options.getRoleId('target_role') : null;
  if (mode === 'in' && !targetRoleId) {
    return answer(
      ctx,
      applicationId,
      errorStatus('Pick the role members need to have to get the new one.'),
    );
  }

  if (targetRoleId === roleId) {
    return answer(
      ctx,
      applicationId,
      errorStatus(
        `You picked <@&${roleId}> for both roles, so everyone who would get it already has it. ` +
          'Nothing was changed.',
      ),
    );
  }

  // A member's `roles` list never contains @everyone, so filtering on it would match nobody and
  // report a run that did nothing rather than the run the invoker meant.
  if (targetRoleId === ctx.guildId) {
    return answer(
      ctx,
      applicationId,
      errorStatus(
        `Every member already has @everyone. Use \`${labelOf(ctx, 'role', 'all')}\` for that.`,
      ),
    );
  }

  const reason = ctx.options.getString('reason');

  const state = await guardedState(ctx, deps, roleId);
  if (isRefusal(state)) return answer(ctx, applicationId, errorStatus(state.refusal));

  const running = await store.get(ctx.guildId);
  if (running) {
    return answer(
      ctx,
      applicationId,
      errorStatus(
        `I'm already giving out <@&${running.roleId}> in this server (${running.applied} members ` +
          `so far). Wait for it to finish, or run \`${labelOf(ctx, 'role', 'cancel')}\` to stop it.`,
      ),
    );
  }

  const run: RoleRun = {
    runId: newId(),
    guildId: ctx.guildId,
    roleId,
    mode,
    ...(targetRoleId ? { targetRoleId } : {}),
    actorId: ctx.userId,
    actorRoleIds: ctx.actorRoleIds ?? [],
    channelId: ctx.channelId,
    ...(reason ? { reason } : {}),
    after: '0',
    scanned: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    listFailures: 0,
    ...(state.memberCount ? { approximateTotal: state.memberCount } : {}),
    startedAt: Date.now(),
    cancelled: false,
  };

  // The progress message goes up before anything is stored: it is the one step that can fail on
  // this server's permissions, and failing it here changes nothing rather than leaving a run
  // booked that nobody can watch.
  const posted = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ctx.userId,
    dryRun: false,
    record: false,
    idempotencyKey: `${ctx.idempotencyKey}:role-run-progress`,
    payload: {
      channelId: ctx.channelId,
      content: renderProgress(run, ctx).slice(0, 2000),
      // The progress line names the role being handed out. Without this, announcing a mass grant
      // of a mentionable role pings everyone already in it. Only the send notifies — Discord does
      // not re-notify for the edits that follow.
      allowedMentions: { parse: [] },
    },
  });

  if (posted.status !== 'executed') {
    return answer(
      ctx,
      applicationId,
      errorStatus(
        `${posted.failure?.humanReason ?? `I couldn't post the progress message in <#${ctx.channelId}>.`}` +
          '\n\nA mass role change posts its progress as it goes, so I didn’t start this one. ' +
          'Nothing was changed.',
      ),
    );
  }

  const messageId = (posted.body as { id?: unknown } | undefined)?.id;
  if (typeof messageId === 'string') run.messageId = messageId;

  await store.put(run);

  try {
    await ctx.schedule(ROLE_RUN_JOB, new Date(), ROLE_RUN_KEY, undefined, { replace: true });
  } catch (error) {
    await store.clear(ctx.guildId);
    ctx.logger.error(
      `a mass /role run could not be scheduled: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );

    return answer(
      ctx,
      applicationId,
      errorStatus(
        `I couldn't schedule the run for <@&${roleId}>, so it didn't start and nothing was ` +
          'changed. Try again later.',
      ),
    );
  }

  return answer(
    ctx,
    applicationId,
    successStatus(
      `Started giving out <@&${roleId}>. I'm working through the member list and posting ` +
        `progress in <#${ctx.channelId}>. \`${labelOf(ctx, 'role', 'cancel')}\` stops it.`,
    ),
  );
}

async function cancel(ctx: CommandContext<ModerationConfig>, deps: ModerationDeps): Promise<void> {
  const store = deps.roleRuns;
  if (!store) {
    return reply(ctx, errorStatus('There’s no mass role change to cancel.'));
  }

  const answer = await acknowledge(ctx, deps);

  const running = await store.get(ctx.guildId);
  if (!running) return answer(errorStatus('No mass role change is running in this server.'));

  if (running.cancelled) {
    return answer(
      errorStatus(
        `The run giving out <@&${running.roleId}> is already stopping. It finishes the batch ` +
          'it’s on, then stops.',
      ),
    );
  }

  await store.put({ ...running, cancelled: true });

  // Booked as well as flagged: a run whose tick was lost — a worker that died between chunks —
  // has nothing coming to read the flag, and would hold the guild's one run slot until the key
  // expired a day later. A tick that arrives to find no run simply returns.
  await ctx.schedule?.(ROLE_RUN_JOB, new Date(), ROLE_RUN_KEY, undefined, { replace: true });

  return answer(
    successStatus(
      `Stopping the run giving out <@&${running.roleId}>. The ${running.applied} members who ` +
        'already got it keep it, because cancelling doesn’t remove it.',
    ),
  );
}
