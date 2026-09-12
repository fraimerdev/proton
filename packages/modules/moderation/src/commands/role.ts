import {
  type CommandContext,
  type CommandDefinition,
  type GuildState,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  newId,
  Permissions,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { isRefusal, MODULE_ID, perform, type Refusal, reasonRefusal, reply } from '../perform.ts';
import { guardRole, guardTarget } from '../role-guard.ts';
import { ROLE_RUN_JOB, ROLE_RUN_KEY, renderProgress } from '../role-run.ts';
import type { RoleRun, RoleRunMode } from '../run-store.ts';

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
    description: 'Manage roles.',

    data: new SlashCommandBuilder()
      .setName('role')
      .setDescription('Manage roles.')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(Permissions.ManageRoles | Permissions.ModerateMembers)
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a role to a user.')
          .addUserOption((o) =>
            o.setName('user').setDescription('The user to add the role to.').setRequired(true),
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
          .setDescription('Remove a role from a user.')
          .addUserOption((o) =>
            o.setName('user').setDescription('The user to remove the role from.').setRequired(true),
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
          .setDescription('Add a role to all users.')
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
          .setDescription('Add a role to all bots.')
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
          .setDescription('Add a role to all users excluding bots.')
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
          .setDescription('Add a role to users with a specific role.')
          .addRoleOption((o) =>
            o.setName('role').setDescription('The role to add.').setRequired(true),
          )
          .addRoleOption((o) =>
            o
              .setName('target_role')
              .setDescription('The role that users must have to receive the new role.')
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
        s.setName('cancel').setDescription('Stop a mass role run that is still going.'),
      )
      .toJSON(),

    async handler(ctx) {
      const sub = ctx.options.getSubcommand() ?? '';

      if (sub === 'add' || sub === 'remove') return one(ctx, deps, sub);

      const mode = MASS_MODES[sub];
      if (mode) return mass(ctx, deps, mode);

      if (sub === 'cancel') return cancel(ctx, deps);

      return reply(
        ctx,
        'Use /role add or /role remove for one member, or /role all, /role bots, /role humans ' +
          'or /role in to give a role to many at once.',
      );
    },
  };
}

// Returns rather than replies: the mass path has already deferred by the time it calls this, so
// its refusals have to go out as followups and not as a second interaction callback.
async function guardedState(
  ctx: CommandContext<ModerationConfig>,
  deps: ModerationDeps,
  roleId: string,
): Promise<GuildState | Refusal> {
  if (!deps.guildState) {
    return {
      refusal:
        'I cannot read this server’s role list, so I cannot check that handing that role out is ' +
        'allowed. Nothing was changed. This is a Proton problem, not a setting in this server.',
    };
  }

  const state = await deps.guildState.get(ctx.guildId);
  if (!state) {
    return {
      refusal:
        "I don't have this server's roles yet, so I can't check that handing that one out is " +
        'allowed. Try again shortly.',
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
      ephemeral: !ctx.config.publicReplies,
    },
  });

  return result.status === 'executed' || result.status === 'skipped_duplicate';
}

async function answer(
  ctx: CommandContext<ModerationConfig>,
  applicationId: string,
  content: string,
): Promise<void> {
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
      ephemeral: !ctx.config.publicReplies,
      content: content.slice(0, 2000),
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
  if (!userId) return reply(ctx, 'I need a member to change the roles of.');

  const roleId = ctx.options.getRoleId('role');
  if (!roleId) return reply(ctx, 'I need a role to hand out.');

  const state = await guardedState(ctx, deps, roleId);
  if (isRefusal(state)) return reply(ctx, state.refusal);

  if (!deps.fetchMemberRoles) {
    return reply(
      ctx,
      'I cannot read that member’s roles, so I cannot check that you outrank them. Nothing was ' +
        'changed. This is a Proton problem, not a setting in this server.',
    );
  }

  const targetRoleIds = await deps.fetchMemberRoles(ctx.guildId, userId);
  if (!targetRoleIds) {
    return reply(
      ctx,
      "I couldn't look up that member's roles, so I can't confirm you outrank them. This " +
        'usually means they just left the server.',
    );
  }

  const outranked = guardTarget({
    state,
    actorId: ctx.userId,
    actorRoleIds: ctx.actorRoleIds,
    targetId: userId,
    targetRoleIds,
  });

  if (outranked) return reply(ctx, outranked.refusal);

  const reason = ctx.options.getString('reason');

  return perform(ctx, {
    kind: sub === 'add' ? 'add_role' : 'remove_role',
    targetId: userId,
    payload: { userId, roleId },
    ...(reason ? { reason } : {}),
    targetRoleIds,
    success:
      sub === 'add'
        ? `Gave <@&${roleId}> to <@${userId}>.`
        : `Took <@&${roleId}> off <@${userId}>.`,
  });
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
      'I cannot run a mass role change in this deployment — the member lister, the run store or ' +
        'the scheduler is not wired into me. Nothing was changed. Use /role add for one member ' +
        'at a time.',
    );
  }

  // Deferred before anything else: what follows posts a message, writes Redis and books a job,
  // and Discord closes the interaction three seconds after it arrives. Everything from here
  // answers as a followup.
  if (!(await defer(ctx))) return;

  const roleId = ctx.options.getRoleId('role');
  if (!roleId) return answer(ctx, applicationId, 'I need a role to hand out.');

  const targetRoleId = mode === 'in' ? ctx.options.getRoleId('target_role') : null;
  if (mode === 'in' && !targetRoleId) {
    return answer(
      ctx,
      applicationId,
      'I need the role a member must already hold to receive the new one.',
    );
  }

  if (targetRoleId === roleId) {
    return answer(
      ctx,
      applicationId,
      'Those are the same role, so everybody who would receive it already has it. Nothing was ' +
        'changed.',
    );
  }

  // A member's `roles` list never contains @everyone, so filtering on it would match nobody and
  // report a run that did nothing rather than the run the invoker meant.
  if (targetRoleId === ctx.guildId) {
    return answer(
      ctx,
      applicationId,
      'Every member already has @everyone — use `/role all` for that.',
    );
  }

  const reason = ctx.options.getString('reason');

  const missingReason = reasonRefusal(ctx, reason);
  if (missingReason) return answer(ctx, applicationId, missingReason.refusal);

  const state = await guardedState(ctx, deps, roleId);
  if (isRefusal(state)) return answer(ctx, applicationId, state.refusal);

  const running = await store.get(ctx.guildId);
  if (running) {
    return answer(
      ctx,
      applicationId,
      `I'm already giving <@&${running.roleId}> out in this server, ${running.applied} members ` +
        'in. Wait for it to finish, or run `/role cancel` to stop it.',
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
      content: renderProgress(run).slice(0, 2000),
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
      `${posted.failure?.humanReason ?? "I couldn't post the progress message."}\n\nA mass role ` +
        'change reports as it goes, so I have not started one. Nothing was changed.',
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
      "I couldn't book the run, so I have not started one and nothing was changed. Try again " +
        'shortly.',
    );
  }

  return answer(
    ctx,
    applicationId,
    `Started. I'm working through the member list now and reporting into <#${ctx.channelId}> ` +
      'as I go. `/role cancel` stops it.',
  );
}

async function cancel(ctx: CommandContext<ModerationConfig>, deps: ModerationDeps): Promise<void> {
  const store = deps.roleRuns;
  if (!store) return reply(ctx, 'There is no mass role run to cancel in this deployment.');

  const running = await store.get(ctx.guildId);
  if (!running) return reply(ctx, 'No mass role run is going in this server.');

  if (running.cancelled) {
    return reply(ctx, 'That run is already stopping — it finishes the chunk it is on and stops.');
  }

  await store.put({ ...running, cancelled: true });

  // Booked as well as flagged: a run whose tick was lost — a worker that died between chunks —
  // has nothing coming to read the flag, and would hold the guild's one run slot until the key
  // expired a day later. A tick that arrives to find no run simply returns.
  await ctx.schedule?.(ROLE_RUN_JOB, new Date(), ROLE_RUN_KEY, undefined, { replace: true });

  return reply(
    ctx,
    `Stopping. <@&${running.roleId}> stays with the ${running.applied} members who already have ` +
      'it — cancelling does not take it back off them.',
  );
}
